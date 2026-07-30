"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const DEFAULT_LOGIN_URL = "https://chatgpt.com/";
const DEFAULT_SETTINGS_URL = "https://chatgpt.com/#settings/Security";
const DEFAULT_PASSWORD_LENGTH = 24;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 300_000;
const DEFAULT_DELAY_MS = 2_000;
const CONTROL_STABILITY_MS = 500;
const STATE_VERSION = 1;
const INVALID_CREDENTIALS_PATTERN = /wrong password|incorrect password|(?:incorrect|wrong) email(?: address)? or password|email(?: address)? or password is incorrect|invalid credentials|password was rejected|rejected the email/i;

function parseCredentialList(raw) {
  const records = [];
  const seenEmails = new Set();

  for (const [index, originalLine] of raw.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const firstSeparator = originalLine.indexOf("|");
    const lastSeparator = originalLine.lastIndexOf("|");
    if (firstSeparator <= 0 || lastSeparator <= firstSeparator) {
      throw new Error(
        `Invalid account at line ${lineNumber}. Expected email|password|MFA-secret.`,
      );
    }

    const email = originalLine.slice(0, firstSeparator).trim();
    const password = originalLine.slice(firstSeparator + 1, lastSeparator).trim();
    const mfaSecret = originalLine.slice(lastSeparator + 1).trim();
    if (!email || !email.includes("@")) {
      throw new Error(`Invalid email at line ${lineNumber}.`);
    }
    if (!password) {
      throw new Error(`Missing password at line ${lineNumber}.`);
    }
    if (!mfaSecret) {
      throw new Error(
        `Missing MFA secret at line ${lineNumber}. Use "-" only for an account without MFA.`,
      );
    }

    const emailKey = email.toLowerCase();
    if (seenEmails.has(emailKey)) {
      throw new Error(`Duplicate account at line ${lineNumber}: ${email}`);
    }
    seenEmails.add(emailKey);

    if (mfaSecret !== "-") {
      decodeBase32(extractMfaSecret(mfaSecret));
    }

    records.push({
      email,
      password,
      mfaSecret,
      lineNumber,
    });
  }

  if (records.length === 0) {
    throw new Error("No accounts found in the input file.");
  }

  return records;
}

function formatCredentialList(records) {
  return `${records
    .map((record) => `${record.email}|${record.password}|${record.mfaSecret}`)
    .join("\n")}\n`;
}

function defaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  const extension = parsed.ext || ".txt";
  return path.join(parsed.dir, `${parsed.name}.rotated${extension}`);
}

function randomCharacter(alphabet) {
  return alphabet[crypto.randomInt(0, alphabet.length)];
}

function generatePassword(length = DEFAULT_PASSWORD_LENGTH) {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new Error("Password length must be an integer from 16 to 128.");
  }

  const groups = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%^&*_-+=",
  ];
  const alphabet = groups.join("");
  const characters = groups.map(randomCharacter);
  while (characters.length < length) {
    characters.push(randomCharacter(alphabet));
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ];
  }
  return characters.join("");
}

function extractMfaSecret(value) {
  if (!value.toLowerCase().startsWith("otpauth://")) {
    return value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid otpauth MFA URI.");
  }
  const secret = parsed.searchParams.get("secret");
  if (!secret) {
    throw new Error("The otpauth MFA URI does not contain a secret.");
  }
  return secret;
}

function decodeBase32(value) {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("Invalid MFA secret. Expected a Base32 authenticator secret.");
  }

  let bits = "";
  for (const character of normalized) {
    const numeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    bits += numeric.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(
  secret,
  nowMs = Date.now(),
  {
    digits = 6,
    periodSeconds = 30,
    algorithm = "sha1",
  } = {},
) {
  const key = decodeBase32(extractMfaSecret(secret));
  const counter = Math.floor(nowMs / 1000 / periodSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algorithm, key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writePrivateAtomic(filePath, contents) {
  const destination = path.resolve(filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    fs.renameSync(temporary, destination);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function writeRotationOutput(outputPath, records) {
  writePrivateAtomic(outputPath, formatCredentialList(records));
}

function writeRotationState(statePath, state) {
  writePrivateAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readRotationState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const state = JSON.parse(raw);
  if (state.version !== STATE_VERSION || typeof state.accounts !== "object") {
    throw new Error(`Unsupported rotation state: ${statePath}`);
  }
  return state;
}

function warnIfInputPermissionsAreBroad(inputPath, io) {
  if (process.platform === "win32") {
    return;
  }
  const mode = fs.statSync(inputPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    io.error(
      `Warning: ${inputPath} is readable by group/other (${mode.toString(8)}). `
      + `Run: chmod 600 "${inputPath}"`,
    );
  }
}

function parsePositiveInteger(value, flagName, minimum, maximum) {
  if (!/^\d+$/.test(value || "")) {
    throw new Error(`${flagName} must be an integer.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${flagName} must be from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseRotationArgs(args, cwd = process.cwd()) {
  const options = {
    inputPath: null,
    outputPath: null,
    passwordLength: DEFAULT_PASSWORD_LENGTH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    manualTimeoutMs: DEFAULT_MANUAL_TIMEOUT_MS,
    delayMs: DEFAULT_DELAY_MS,
    browserChannel: process.env.CODEX_ACCOUNT_BROWSER_CHANNEL || "chrome",
    browserExecutable: process.env.CODEX_ACCOUNT_BROWSER_EXECUTABLE || null,
    dryRun: false,
    yes: false,
    resume: false,
    continueOnError: false,
    unattended: false,
    verifyLogin: true,
    loginUrl: process.env.CODEX_ACCOUNT_LOGIN_URL || DEFAULT_LOGIN_URL,
    settingsUrl: process.env.CODEX_ACCOUNT_SETTINGS_URL || DEFAULT_SETTINGS_URL,
  };

  const valueFlags = new Map([
    ["--output", "outputPath"],
    ["--password-length", "passwordLength"],
    ["--timeout-ms", "timeoutMs"],
    ["--manual-timeout-ms", "manualTimeoutMs"],
    ["--delay-ms", "delayMs"],
    ["--browser-channel", "browserChannel"],
    ["--browser-executable", "browserExecutable"],
  ]);
  const booleanFlags = new Map([
    ["--dry-run", ["dryRun", true]],
    ["--yes", ["yes", true]],
    ["--resume", ["resume", true]],
    ["--continue-on-error", ["continueOnError", true]],
    ["--unattended", ["unattended", true]],
    ["--skip-verify", ["verifyLogin", false]],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (booleanFlags.has(argument)) {
      const [key, value] = booleanFlags.get(argument);
      options[key] = value;
      continue;
    }
    if (valueFlags.has(argument)) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument}.`);
      }
      options[valueFlags.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown rotate-passwords option: ${argument}`);
    }
    if (options.inputPath) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    options.inputPath = argument;
  }

  if (!options.inputPath) {
    throw new Error("Missing account list. Expected: codex-acc rotate-passwords <file>");
  }
  options.inputPath = path.resolve(cwd, options.inputPath);
  options.outputPath = path.resolve(
    cwd,
    options.outputPath || defaultOutputPath(options.inputPath),
  );
  options.statePath = `${options.outputPath}.state.json`;
  options.passwordLength = parsePositiveInteger(
    String(options.passwordLength),
    "--password-length",
    16,
    128,
  );
  options.timeoutMs = parsePositiveInteger(
    String(options.timeoutMs),
    "--timeout-ms",
    5_000,
    600_000,
  );
  options.manualTimeoutMs = parsePositiveInteger(
    String(options.manualTimeoutMs),
    "--manual-timeout-ms",
    30_000,
    1_800_000,
  );
  options.delayMs = parsePositiveInteger(
    String(options.delayMs),
    "--delay-ms",
    0,
    300_000,
  );
  if (options.outputPath === options.inputPath) {
    throw new Error("Output must be a different file from the input.");
  }

  return options;
}

async function confirmRotation(count, options) {
  if (options.yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive confirmation is unavailable. Re-run with --yes.");
  }

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await terminal.question(
      `Change passwords for ${count} account(s) on chatgpt.com? Type "rotate" to continue: `,
    );
    return answer.trim().toLowerCase() === "rotate";
  } finally {
    terminal.close();
  }
}

async function visible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) {
      return candidate;
    }
  }
  return null;
}

async function findVisible(page, candidates) {
  for (const candidate of candidates) {
    const locator = candidate(page);
    const visibleLocator = await visible(locator);
    if (visibleLocator) {
      return visibleLocator;
    }
  }
  return null;
}

async function waitForValue(producer, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      if (value) {
        return value;
      }
    } catch (error) {
      if (error.accountStatus) {
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const detail = lastError ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

function reportStep(options, message) {
  if (typeof options.onStep === "function") {
    options.onStep(message);
  }
}

function createAccountError(accountStatus, message, cause = null) {
  const error = cause
    ? new Error(message, { cause })
    : new Error(message);
  error.accountStatus = accountStatus;
  return error;
}

function accountStatusFromError(error) {
  if (error?.accountStatus) {
    return error.accountStatus;
  }
  const message = String(error?.message || error || "");
  if (/deactivated|disabled|suspended|deleted|banned|no longer have access/i.test(message)) {
    return "banned";
  }
  if (INVALID_CREDENTIALS_PATTERN.test(message)) {
    return "invalid_credentials";
  }
  if (/MFA|one-time|verification code|authenticator code/i.test(message)) {
    return "invalid_mfa";
  }
  if (/verification|required|unsupported provider/i.test(message)) {
    return "verification_required";
  }
  if (/invalid content type|routeerror|cloudflare|browser challenge|auth service/i.test(message)) {
    return "auth_error";
  }
  return "check_failed";
}

function loginFailureFromText(text) {
  if (!text) {
    return null;
  }
  if (
    /account (?:has been |was )?(?:deactivated|disabled|suspended|deleted)|account.*banned|you no longer have access/i
      .test(text)
  ) {
    return createAccountError("banned", "The OpenAI account is disabled, suspended, or banned.");
  }
  if (INVALID_CREDENTIALS_PATTERN.test(text)) {
    return createAccountError("invalid_credentials", "The current password was rejected.");
  }
  if (/invalid (?:verification|authenticator|one-time) code|incorrect code/i.test(text)) {
    return createAccountError("invalid_mfa", "The MFA verification code was rejected.");
  }
  if (/invalid email|could not find (?:the )?account|account (?:does not|doesn't) exist/i.test(text)) {
    return createAccountError("invalid_credentials", "The login page rejected the email address.");
  }
  if (
    /routeerror|invalid content type:\s*text\/html|oops, an error occurred|checking your browser|cloudflare|browser challenge/i
      .test(text)
  ) {
    return createAccountError(
      "auth_error",
      "OpenAI authentication returned an HTML error or browser challenge. Retry from a fresh private window.",
    );
  }
  return null;
}

async function gotoReady(page, url, timeoutMs, description) {
  await page.goto(url, {
    waitUntil: "load",
    timeout: timeoutMs,
  });
  await waitForValue(
    async () => {
      const readyState = await page.evaluate(() => document.readyState);
      return readyState === "complete" ? true : null;
    },
    timeoutMs,
    description,
  );
}

async function fillStable(locator, value, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await locator.waitFor({
        state: "visible",
        timeout: Math.min(1_000, remaining),
      });
      if (!(await locator.isEnabled()) || !(await locator.isEditable())) {
        throw new Error("the control is not enabled and editable yet");
      }
      await locator.fill(value, { timeout: remaining });
      await new Promise((resolve) => setTimeout(resolve, CONTROL_STABILITY_MS));
      if (
        await locator.isVisible()
        && await locator.isEnabled()
        && await locator.isEditable()
        && await locator.inputValue() === value
      ) {
        return;
      }
      lastError = new Error("the page replaced or cleared the control after filling");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const detail = lastError ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${description} to remain filled${detail}`);
}

async function clickStable(locator, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let clickStarted = false;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await locator.waitFor({
        state: "visible",
        timeout: Math.min(1_000, remaining),
      });
      if (!(await locator.isEnabled())) {
        throw new Error("the control is not enabled yet");
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_STABILITY_MS));
      if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
        throw new Error("the page replaced the control before it was clicked");
      }
      clickStarted = true;
      await locator.click({ timeout: Math.max(1, deadline - Date.now()) });
      return;
    } catch (error) {
      if (clickStarted) {
        throw new Error(`Failed to click ${description}: ${error.message}`, {
          cause: error,
        });
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const detail = lastError ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting to click ${description}${detail}`);
}

async function pageText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 2_000 });
  } catch {
    return "";
  }
}

function loginCompleted(page, options) {
  const current = new URL(page.url());
  const settings = new URL(options.settingsUrl);
  const login = new URL(options.loginUrl);
  if (
    current.origin !== settings.origin
    || /^\/(?:auth|login|log-in|signin|sign-in)(?:\/|$)/i.test(current.pathname)
  ) {
    return false;
  }
  if (
    login.pathname !== "/"
    && current.origin === login.origin
    && current.pathname === login.pathname
  ) {
    return false;
  }
  return true;
}

async function clickContinue(page, timeoutMs) {
  const button = await waitForValue(
    () => findVisible(page, [
      (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
      (scope) => scope.getByRole("button", { name: "Verify", exact: true }),
      (scope) => scope.getByRole("button", { name: "Log in", exact: true }),
      (scope) => scope.locator('button[type="submit"]'),
    ]),
    timeoutMs,
    "the login submit button",
  );
  await clickStable(button, timeoutMs, "the login submit button");
}

async function waitForFreshTotp(secret) {
  const secondsIntoPeriod = Math.floor(Date.now() / 1000) % 30;
  if (secondsIntoPeriod <= 25) {
    return generateTotp(secret);
  }
  await new Promise((resolve) => setTimeout(resolve, (31 - secondsIntoPeriod) * 1_000));
  return generateTotp(secret);
}

async function loginAccount(page, account, options) {
  const email = String(account.email ?? "").trim();
  const password = String(account.password ?? "").trim();

  reportStep(options, "[Login 1/4] Open ChatGPT and enter the normal login flow.");
  await gotoReady(page, options.loginUrl, options.timeoutMs, "the login page to finish loading");

  reportStep(options, "[Login 2/4] Wait for the email form, enter the email, and continue.");
  let emailInput = await findVisible(page, [
    (scope) => scope.getByRole("textbox", { name: "Email address", exact: true }),
    (scope) => scope.getByLabel("Email address", { exact: true }),
    (scope) => scope.locator('input[type="email"]'),
  ]);
  if (!emailInput) {
    const loginAction = await waitForValue(async () => {
      const failure = loginFailureFromText(await pageText(page));
      if (failure) {
        throw failure;
      }
      return findVisible(page, [
        (scope) => scope.getByRole("button", { name: /^(log|sign) in$/i }),
        (scope) => scope.getByRole("link", { name: /^(log|sign) in$/i }),
        (scope) => scope.locator('a[href*="/auth/login"]'),
        (scope) => scope.locator('a[href*="auth.openai.com"]'),
      ]);
    }, options.timeoutMs, "the ChatGPT Log in button");
    await clickStable(loginAction, options.timeoutMs, "the ChatGPT Log in button");
  }
  emailInput = emailInput || await waitForValue(
    async () => {
      const failure = loginFailureFromText(await pageText(page));
      if (failure) {
        throw failure;
      }
      return findVisible(page, [
      (scope) => scope.getByRole("textbox", { name: "Email address", exact: true }),
      (scope) => scope.getByLabel("Email address", { exact: true }),
      (scope) => scope.locator('input[type="email"]'),
      ]);
    },
    options.timeoutMs,
    "the email field",
  );
  await fillStable(emailInput, email, options.timeoutMs, "the email field");
  await clickContinue(page, options.timeoutMs);

  reportStep(options, "[Login 3/4] Wait for the password form, enter the current password, and continue.");
  const passwordInput = await waitForValue(
    async () => {
      const errorText = await pageText(page);
      const failure = loginFailureFromText(errorText);
      if (failure) {
        throw failure;
      }
      return findVisible(page, [
        (scope) => scope.getByLabel("Password", { exact: true }),
        (scope) => scope.locator('input[autocomplete="current-password"]'),
        (scope) => scope.locator('input[type="password"]'),
      ]);
    },
    options.timeoutMs,
    "the password field",
  );
  await fillStable(passwordInput, password, options.timeoutMs, "the password field");
  await clickContinue(page, options.timeoutMs);

  reportStep(options, "[Login 4/4] Complete MFA or wait for login confirmation.");
  const loginResult = await waitForValue(
    async () => {
      if (loginCompleted(page, options)) {
        return "complete";
      }
      const text = await pageText(page);
      const failure = loginFailureFromText(text);
      if (failure) {
        throw failure;
      }
      const mfaInput = await findVisible(page, [
        (scope) => scope.locator('input[autocomplete="one-time-code"]'),
        (scope) => scope.getByLabel("Code", { exact: true }),
        (scope) => scope.getByLabel("Verification code", { exact: true }),
        (scope) => scope.locator('input[inputmode="numeric"]'),
      ]);
      return mfaInput || null;
    },
    options.timeoutMs,
    "login or MFA verification",
  );

  if (loginResult === "complete") {
    return;
  }

  if (account.mfaSecret !== "-") {
    await fillStable(
      loginResult,
      await waitForFreshTotp(account.mfaSecret),
      options.timeoutMs,
      "the MFA field",
    );
    await clickContinue(page, options.timeoutMs);
  } else if (options.unattended) {
    throw createAccountError(
      "verification_required",
      "The account requested verification but no MFA secret was supplied.",
    );
  }

  try {
    await waitForValue(
      async () => {
        if (loginCompleted(page, options)) {
          return true;
        }
        const failure = loginFailureFromText(await pageText(page));
        if (failure) {
          throw failure;
        }
        return null;
      },
      options.timeoutMs,
      "login completion",
    );
  } catch (error) {
    if (options.unattended) {
      throw error;
    }
    console.log(
      `Additional verification is required for ${account.email}. Complete it in the browser window.`,
    );
    await waitForValue(
      () => (loginCompleted(page, options) ? true : null),
      options.manualTimeoutMs,
      "manual login verification",
    );
  }
}

async function passwordAction(page) {
  return findVisible(page, [
    (scope) => scope.getByTestId("password-setting"),
    (scope) => scope.getByRole("button", { name: "Update password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Change password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Add password", exact: true }),
    (scope) => scope.getByText("Update password", { exact: true }),
    (scope) => scope.getByText("Change password", { exact: true }),
    (scope) => scope.getByText("Add password", { exact: true }),
  ]);
}

async function openAccountSettings(page, options) {
  await gotoReady(
    page,
    options.settingsUrl,
    options.timeoutMs,
    "the security and login settings page to finish loading",
  );

  const settingsTarget = async () => {
    const action = await passwordAction(page);
    if (action) {
      return { action };
    }
    const tab = await findVisible(page, [
      (scope) => scope.getByRole("tab", { name: /^Security(?: and| &) login$/i }),
      (scope) => scope.getByRole("button", { name: /^Security(?: and| &) login$/i }),
      (scope) => scope.getByText(/^Security(?: and| &) login$/i),
      (scope) => scope.getByRole("tab", { name: "Security", exact: true }),
      (scope) => scope.getByRole("button", { name: "Security", exact: true }),
      (scope) => scope.getByText("Security", { exact: true }),
      (scope) => scope.locator('a[href*="#settings/Security"]'),
    ]);
    return tab ? { tab } : null;
  };

  let initialTarget = null;
  try {
    initialTarget = await waitForValue(
      settingsTarget,
      Math.min(options.timeoutMs, 5_000),
      "the Security and login settings panel to open",
    );
  } catch {
    // Some UI variants ignore the settings hash and require the profile menu.
  }
  if (initialTarget?.action) {
    return initialTarget.action;
  }
  if (initialTarget?.tab) {
    await clickStable(
      initialTarget.tab,
      options.timeoutMs,
      "the Security and login settings tab",
    );
    return waitForValue(
      () => passwordAction(page),
      options.timeoutMs,
      "the Password row in Settings > Security and login",
    );
  }

  const profileMenu = await findVisible(page, [
    (scope) => scope.getByRole("button", { name: "Open profile menu", exact: true }),
    (scope) => scope.getByRole("button", { name: "Profile", exact: true }),
    (scope) => scope.getByRole("button", { name: "Account menu", exact: true }),
    (scope) => scope.locator('button[data-testid="profile-button"]'),
  ]);
  if (profileMenu) {
    await clickStable(profileMenu, options.timeoutMs, "the profile menu");
    const settings = await waitForValue(
      () => findVisible(page, [
        (scope) => scope.getByRole("menuitem", { name: "Settings", exact: true }),
        (scope) => scope.getByRole("button", { name: "Settings", exact: true }),
        (scope) => scope.getByText("Settings", { exact: true }),
      ]),
      options.timeoutMs,
      "the Settings menu item",
    );
    await clickStable(settings, options.timeoutMs, "the Settings menu item");
  }

  const securityTarget = await waitForValue(
    settingsTarget,
    options.timeoutMs,
    "the Security and login settings tab",
  );
  if (securityTarget.action) {
    return securityTarget.action;
  }
  await clickStable(
    securityTarget.tab,
    options.timeoutMs,
    "the Security and login settings tab",
  );

  return waitForValue(
    () => passwordAction(page),
    options.timeoutMs,
    "the Password row in Settings > Security and login",
  );
}

async function fillPasswordForm(page, account, newPassword, options) {
  reportStep(options, "[Rotation 4/7] Verify the current password when requested.");
  const detectVerificationStage = async () => {
    const failure = loginFailureFromText(await pageText(page));
    if (failure) {
      throw failure;
    }

    const newInput = await findVisible(page, [
      (scope) => scope.getByLabel("New password", { exact: true }),
      (scope) => scope.locator('input[autocomplete="new-password"]'),
      (scope) => scope.locator('input[name="newPassword"]'),
    ]);
    if (newInput) {
      return { stage: "new-password" };
    }

    const mfaInput = await findVisible(page, [
      (scope) => scope.getByLabel("One-time code", { exact: true }),
      (scope) => scope.getByLabel("Code", { exact: true }),
      (scope) => scope.getByLabel("Verification code", { exact: true }),
      (scope) => scope.locator('input[autocomplete="one-time-code"]'),
      (scope) => scope.locator('input[inputmode="numeric"]'),
    ]);
    if (mfaInput) {
      const submit = await findVisible(page, [
        (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
        (scope) => scope.getByRole("button", { name: "Verify", exact: true }),
        (scope) => scope.locator('button[type="submit"]'),
      ]);
      return submit ? { stage: "mfa", input: mfaInput, submit } : null;
    }

    const heading = await findVisible(page, [
      (scope) => scope.getByRole("heading", { name: "First, verify it's you", exact: true }),
      (scope) => scope.getByText("First, verify it's you", { exact: true }),
    ]);
    if (!heading) {
      return null;
    }
    const input = await findVisible(page, [
      (scope) => scope.getByLabel("Password", { exact: true }),
      (scope) => scope.locator('input[autocomplete="current-password"]'),
      (scope) => scope.locator('input[type="password"]'),
    ]);
    const submit = await findVisible(page, [
      (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
      (scope) => scope.locator('button[type="submit"]'),
    ]);
    return input && submit
      ? { stage: "current-password", input, submit }
      : null;
  };

  let verification = await waitForValue(
    detectVerificationStage,
    options.timeoutMs,
    "current-password, authenticator, or new-password form",
  );
  const currentPasswordVerified = verification.stage === "current-password";

  if (currentPasswordVerified) {
    await fillStable(
      verification.input,
      String(account.password ?? "").trim(),
      options.timeoutMs,
      "the password verification field",
    );
    await clickStable(
      verification.submit,
      options.timeoutMs,
      "the password verification Continue button",
    );
    verification = await waitForValue(
      async () => {
        const next = await detectVerificationStage();
        return next?.stage !== "current-password" ? next : null;
      },
      options.timeoutMs,
      "authenticator verification or the new-password form",
    );
  }

  if (verification.stage === "mfa") {
    reportStep(options, "[Rotation 4/7] Enter the authenticator one-time code.");
    if (account.mfaSecret !== "-") {
      await fillStable(
        verification.input,
        await waitForFreshTotp(account.mfaSecret),
        options.timeoutMs,
        "the authenticator one-time-code field",
      );
      await clickStable(
        verification.submit,
        options.timeoutMs,
        "the authenticator Continue button",
      );
      await waitForValue(
        async () => {
          const next = await detectVerificationStage();
          return next?.stage === "new-password" ? next : null;
        },
        options.timeoutMs,
        "the new-password form after authenticator verification",
      );
    } else if (options.unattended) {
      throw createAccountError(
        "verification_required",
        "Password rotation requested an authenticator code but no MFA secret was supplied.",
      );
    } else {
      console.log(
        `Authenticator verification is required for ${account.email}. Complete it in the browser window.`,
      );
      await waitForValue(
        async () => {
          const next = await detectVerificationStage();
          return next?.stage === "new-password" ? next : null;
        },
        options.manualTimeoutMs,
        "manual authenticator verification",
      );
    }
  }

  reportStep(options, "[Rotation 5/7] Fill and submit the new password.");
  const passwordInputs = page.locator('input[type="password"]');
  const fields = await waitForValue(async () => {
    const failure = loginFailureFromText(await pageText(page));
    if (failure) {
      throw failure;
    }
    const currentInput = await findVisible(page, [
      (scope) => scope.getByLabel("Current password", { exact: true }),
      (scope) => scope.locator('input[autocomplete="current-password"]'),
      (scope) => scope.locator('input[name="currentPassword"]'),
    ]);
    let newInput = await findVisible(page, [
      (scope) => scope.getByLabel("New password", { exact: true }),
      (scope) => scope.locator('input[name="newPassword"]'),
    ]);
    let confirmInput = await findVisible(page, [
      (scope) => scope.getByLabel("Confirm password", { exact: true }),
      (scope) => scope.getByLabel("Confirm new password", { exact: true }),
      (scope) => scope.locator('input[name="confirmPassword"]'),
    ]);

    if (!newInput || !confirmInput) {
      const newPasswordInputs = page.locator('input[autocomplete="new-password"]');
      const count = await newPasswordInputs.count();
      if (!newInput && count >= 1) {
        newInput = newPasswordInputs.nth(0);
      }
      if (!confirmInput && count >= 2) {
        confirmInput = newPasswordInputs.nth(1);
      }
    }

    if (!newInput) {
      const count = await passwordInputs.count();
      const index = currentInput ? 1 : 0;
      if (count > index) {
        newInput = passwordInputs.nth(index);
      }
    }
    if (!confirmInput) {
      const count = await passwordInputs.count();
      const index = currentInput ? 2 : 1;
      if (count > index) {
        confirmInput = passwordInputs.nth(index);
      }
    }

    return newInput && confirmInput
      ? { currentInput, newInput, confirmInput }
      : null;
  }, options.timeoutMs, "all fields in the password update form");

  let { currentInput } = fields;
  const { newInput, confirmInput } = fields;
  if (currentPasswordVerified) {
    currentInput = null;
  }
  if (currentInput) {
    await fillStable(
      currentInput,
      String(account.password ?? "").trim(),
      options.timeoutMs,
      "the current-password field",
    );
  }

  await fillStable(newInput, newPassword, options.timeoutMs, "the new-password field");
  await fillStable(
    confirmInput,
    newPassword,
    options.timeoutMs,
    "the password confirmation field",
  );

  const submit = await waitForValue(
    () => findVisible(page, [
      (scope) => scope.getByRole("button", { name: "Update password", exact: true }),
      (scope) => scope.getByRole("button", { name: "Change password", exact: true }),
      (scope) => scope.getByRole("button", { name: "Save password", exact: true }),
      (scope) => scope.getByRole("button", { name: "Save", exact: true }),
      (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
      (scope) => scope.locator('button[type="submit"]'),
    ]),
    options.timeoutMs,
    "the final password update button",
  );
  await clickStable(submit, options.timeoutMs, "the final password update button");
}

async function findAuthenticatorChallenge(page) {
  const input = await findVisible(page, [
    (scope) => scope.getByLabel("One-time code", { exact: true }),
    (scope) => scope.getByLabel("Code", { exact: true }),
    (scope) => scope.getByLabel("Verification code", { exact: true }),
    (scope) => scope.locator('input[autocomplete="one-time-code"]'),
    (scope) => scope.locator('input[inputmode="numeric"]'),
  ]);
  if (!input) {
    return null;
  }
  const submit = await findVisible(page, [
    (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
    (scope) => scope.getByRole("button", { name: "Verify", exact: true }),
    (scope) => scope.locator('button[type="submit"]'),
  ]);
  return submit ? { input, submit } : null;
}

async function waitForPasswordUpdate(page, account, options, onSubmitted) {
  let authenticatorSubmitted = false;
  let passwordSaved = false;
  const saveSubmittedPassword = async () => {
    if (passwordSaved) {
      return;
    }
    passwordSaved = true;
    await onSubmitted();
  };

  return waitForValue(
    async () => {
      const text = await pageText(page);
      if (/password (has been |was )?(updated|changed|set)|successfully (updated|changed)/i.test(text)) {
        await saveSubmittedPassword();
        return true;
      }
      if (/unable to update|could not update|password.*error|try again/i.test(text)) {
        throw new Error("ChatGPT reported that the password update failed.");
      }
      const failure = loginFailureFromText(text);
      if (failure) {
        throw failure;
      }
      if (authenticatorSubmitted && await passwordAction(page)) {
        return true;
      }
      if (!authenticatorSubmitted) {
        const challenge = await findAuthenticatorChallenge(page);
        if (challenge) {
          if (account.mfaSecret === "-") {
            if (options.unattended) {
              throw createAccountError(
                "verification_required",
                "Password update requested a final authenticator code but no MFA secret was supplied.",
              );
            }
            return null;
          }
          reportStep(options, "[Rotation 6/7] Enter the final authenticator one-time code.");
          await fillStable(
            challenge.input,
            await waitForFreshTotp(account.mfaSecret),
            options.timeoutMs,
            "the final authenticator one-time-code field",
          );
          await clickStable(
            challenge.submit,
            options.timeoutMs,
            "the final authenticator Continue button",
          );
          authenticatorSubmitted = true;
          await saveSubmittedPassword();
        }
      }
      return null;
    },
    options.timeoutMs,
    "password update confirmation",
  );
}

async function rotateOneAccount(browser, account, newPassword, options, onSubmitted) {
  let submitted = false;
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const page = await context.newPage();
    reportStep(options, "[Rotation 1/7] Sign in with the current credentials.");
    await loginAccount(page, account, options);
    reportStep(options, "[Rotation 2/7] Open Settings > Security and login.");
    const action = await openAccountSettings(page, options);
    reportStep(options, "[Rotation 3/7] Open the Password row.");
    await clickStable(action, options.timeoutMs, "the password update action");
    await fillPasswordForm(page, account, newPassword, options);
    reportStep(options, "[Rotation 6/7] Wait for password update confirmation.");
    await waitForPasswordUpdate(page, account, options, async () => {
      submitted = true;
      await onSubmitted();
    });
  } catch (error) {
    error.passwordSubmitted = submitted;
    throw error;
  } finally {
    await context.close();
  }

  if (!options.verifyLogin) {
    reportStep(options, "[Rotation 7/7] Verification login skipped by option.");
    return;
  }

  if (account.mfaSecret !== "-") {
    const secondsIntoPeriod = Math.floor(Date.now() / 1000) % 30;
    await new Promise(
      (resolve) => setTimeout(resolve, (31 - secondsIntoPeriod) * 1_000),
    );
  }

  const verificationContext = await browser.newContext({ locale: "en-US" });
  try {
    reportStep(options, "[Rotation 7/7] Verify the new password in a fresh private session.");
    const verificationPage = await verificationContext.newPage();
    await loginAccount(
      verificationPage,
      { ...account, password: newPassword },
      options,
    );
  } catch (error) {
    error.passwordSubmitted = true;
    throw new Error(`Password changed but verification login failed: ${error.message}`, {
      cause: error,
    });
  } finally {
    await verificationContext.close();
  }
}

async function launchRotationBrowser(options, chromiumOverride = null) {
  let chromium = chromiumOverride;
  if (!chromium) {
    try {
      ({ chromium } = require("playwright-core"));
    } catch {
      throw new Error(
        "Browser automation dependency is missing. Run npm install --global switch-codex-accounts again.",
      );
    }
  }

  const launchOptions = {
    headless: false,
    args: [
      "--incognito",
      "--new-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (options.browserExecutable) {
    launchOptions.executablePath = options.browserExecutable;
  } else if (options.browserChannel) {
    launchOptions.channel = options.browserChannel;
  }

  const contexts = new Set();
  return {
    async newContext(contextOptions = {}) {
      const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-private-"));
      let playwrightContext;
      try {
        playwrightContext = await chromium.launchPersistentContext(profilePath, {
          ...launchOptions,
          ...contextOptions,
        });
      } catch (error) {
        fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        throw createAccountError(
          "auth_error",
          `Could not launch private ${options.browserExecutable || options.browserChannel}: ${error.message}. `
          + "Install Google Chrome, or set CODEX_ACCOUNT_BROWSER_EXECUTABLE.",
          error,
        );
      }

      let closed = false;
      let initialPageClaimed = false;
      const managedContext = {
        async newPage() {
          if (!initialPageClaimed) {
            initialPageClaimed = true;
            const initialPage = playwrightContext.pages().find(
              (candidate) => candidate.url() === "about:blank",
            );
            if (initialPage) {
              return initialPage;
            }
          }
          return playwrightContext.newPage();
        },
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          contexts.delete(managedContext);
          try {
            await playwrightContext.close();
          } finally {
            fs.rmSync(profilePath, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          }
        },
      };
      contexts.add(managedContext);
      return managedContext;
    },
    async close() {
      await Promise.all([...contexts].map((context) => context.close()));
    },
  };
}

function dashboardAutomationOptions(overrides = {}) {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    manualTimeoutMs: DEFAULT_MANUAL_TIMEOUT_MS,
    browserChannel: process.env.CODEX_ACCOUNT_BROWSER_CHANNEL || "chrome",
    browserExecutable: process.env.CODEX_ACCOUNT_BROWSER_EXECUTABLE || null,
    unattended: true,
    verifyLogin: false,
    loginUrl: process.env.CODEX_ACCOUNT_LOGIN_URL || DEFAULT_LOGIN_URL,
    settingsUrl: process.env.CODEX_ACCOUNT_SETTINGS_URL || DEFAULT_SETTINGS_URL,
    ...overrides,
  };
}

async function checkAccounts(records, overrides = {}, io = console) {
  const options = dashboardAutomationOptions(overrides);
  options.onStep = (message) => io.log(`  ${message}`);
  const results = [];
  const browser = await launchRotationBrowser(options);
  try {
    for (const account of records) {
      if (typeof io.onAccountStatus === "function") {
        io.onAccountStatus({
          email: account.email,
          status: "checking",
          message: "Checking login in a fresh private browser session.",
        });
      }
      let context;
      try {
        context = await browser.newContext({ locale: "en-US" });
        const page = await context.newPage();
        await loginAccount(page, account, options);
        const result = {
          email: account.email,
          status: "active",
          message: "Login succeeded.",
        };
        results.push(result);
        if (typeof io.onAccountStatus === "function") {
          io.onAccountStatus(result);
        }
      } catch (error) {
        const result = {
          email: account.email,
          status: accountStatusFromError(error),
          message: error.message,
        };
        results.push(result);
        if (typeof io.onAccountStatus === "function") {
          io.onAccountStatus(result);
        }
      } finally {
        await context?.close();
      }
    }
  } finally {
    await browser.close();
  }
  const success = results.filter((result) => result.status === "active").length;
  return {
    total: results.length,
    success,
    failed: results.length - success,
    results,
  };
}

function createInitialState(options, inputHash, records) {
  return {
    version: STATE_VERSION,
    inputPath: options.inputPath,
    inputSha256: inputHash,
    outputPath: options.outputPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accounts: Object.fromEntries(records.map((record) => [
      record.email.toLowerCase(),
      {
        email: record.email,
        status: "pending",
      },
    ])),
  };
}

function loadResumeRecords(options, inputRaw, records, state) {
  if (state.inputSha256 !== sha256(inputRaw)) {
    throw new Error("The input file changed after the rotation state was created.");
  }
  if (path.resolve(state.outputPath) !== options.outputPath) {
    throw new Error("The rotation state belongs to a different output file.");
  }

  let outputRecords;
  try {
    outputRecords = parseCredentialList(fs.readFileSync(options.outputPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not resume from ${options.outputPath}: ${error.message}`);
  }
  const outputByEmail = new Map(
    outputRecords.map((record) => [record.email.toLowerCase(), record]),
  );

  return records.map((record) => {
    const saved = state.accounts[record.email.toLowerCase()];
    if (!saved || !new Set(["success", "submitted", "submitted-unverified"]).has(saved.status)) {
      return record;
    }
    const outputRecord = outputByEmail.get(record.email.toLowerCase());
    if (!outputRecord) {
      throw new Error(`Resume output is missing ${record.email}.`);
    }
    return {
      ...record,
      password: outputRecord.password,
    };
  });
}

async function rotatePasswords(args, io = console) {
  const options = parseRotationArgs(args);
  options.onStep = (message) => io.log(`  ${message}`);
  const inputRaw = fs.readFileSync(options.inputPath, "utf8");
  const inputHash = sha256(inputRaw);
  let records = parseCredentialList(inputRaw);
  warnIfInputPermissionsAreBroad(options.inputPath, io);

  io.log(`Validated ${records.length} account(s).`);
  io.log(`Output: ${options.outputPath}`);
  io.log(`State:  ${options.statePath}`);
  if (options.dryRun) {
    io.log("Dry run complete. No browser was opened and no password was changed.");
    return {
      total: records.length,
      success: 0,
      failed: 0,
      dryRun: true,
    };
  }

  let state = readRotationState(options.statePath);
  if (state && !options.resume) {
    throw new Error(
      `Rotation state already exists: ${options.statePath}. Use --resume or choose another --output.`,
    );
  }
  if (options.resume && !state) {
    throw new Error(`No rotation state found: ${options.statePath}`);
  }
  if (state) {
    records = loadResumeRecords(options, inputRaw, records, state);
  } else {
    if (fs.existsSync(options.outputPath)) {
      throw new Error(`Output already exists: ${options.outputPath}`);
    }
  }

  if (!(await confirmRotation(records.length, options))) {
    io.log("Cancelled. No password was changed.");
    return {
      total: records.length,
      success: 0,
      failed: 0,
      cancelled: true,
    };
  }

  if (!state) {
    state = createInitialState(options, inputHash, records);
    writeRotationOutput(options.outputPath, records);
    writeRotationState(options.statePath, state);
  }

  io.log("Launching Chrome in incognito mode...");
  const browser = await launchRotationBrowser(options);
  let success = 0;
  let failed = 0;
  try {
    for (const [index, account] of records.entries()) {
      const key = account.email.toLowerCase();
      const saved = state.accounts[key];
      if (saved && new Set(["success", "submitted", "submitted-unverified"]).has(saved.status)) {
        io.log(`[${index + 1}/${records.length}] Skip ${account.email} (${saved.status}).`);
        if (saved.status === "success") {
          success += 1;
        } else {
          failed += 1;
        }
        continue;
      }

      io.log(`[${index + 1}/${records.length}] Rotating ${account.email}...`);
      if (typeof io.onAccountStatus === "function") {
        io.onAccountStatus({
          email: account.email,
          status: "rotating",
          message: "Password rotation is running.",
        });
      }
      const newPassword = generatePassword(options.passwordLength);
      state.accounts[key] = {
        email: account.email,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
      writeRotationState(options.statePath, state);

      let outputUpdated = false;
      const saveSubmittedPassword = async () => {
        records[index] = {
          ...records[index],
          password: newPassword,
        };
        outputUpdated = true;
        writeRotationOutput(options.outputPath, records);
        state.accounts[key] = {
          email: account.email,
          status: "submitted",
          updatedAt: new Date().toISOString(),
        };
        state.updatedAt = new Date().toISOString();
        writeRotationState(options.statePath, state);
        if (typeof io.onPasswordSubmitted === "function") {
          await io.onPasswordSubmitted({
            email: account.email,
            password: newPassword,
          });
        }
        if (typeof io.onAccountStatus === "function") {
          io.onAccountStatus({
            email: account.email,
            status: "rotating",
            message: "The new password was submitted; waiting for confirmation.",
          });
        }
      };

      try {
        await rotateOneAccount(
          browser,
          account,
          newPassword,
          options,
          saveSubmittedPassword,
        );
        state.accounts[key] = {
          email: account.email,
          status: "success",
          updatedAt: new Date().toISOString(),
        };
        success += 1;
        io.log(`  Success: ${account.email}`);
        if (typeof io.onAccountStatus === "function") {
          io.onAccountStatus({
            email: account.email,
            status: "active",
            message: "Password rotated and login verified.",
          });
        }
      } catch (error) {
        const submitted = outputUpdated || error.passwordSubmitted;
        state.accounts[key] = {
          email: account.email,
          status: submitted ? "submitted-unverified" : "failed",
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
        failed += 1;
        io.error(`  Failed: ${account.email} - ${error.message}`);
        if (typeof io.onAccountStatus === "function") {
          io.onAccountStatus({
            email: account.email,
            status: submitted ? "rotation_unverified" : accountStatusFromError(error),
            message: error.message,
          });
        }
        if (submitted) {
          io.error(
            `  The final form was submitted. Keep the new password from ${options.outputPath} and verify this account manually.`,
          );
        }
        if (!options.continueOnError || (submitted && !options.unattended)) {
          state.updatedAt = new Date().toISOString();
          writeRotationState(options.statePath, state);
          break;
        }
      }

      state.updatedAt = new Date().toISOString();
      writeRotationState(options.statePath, state);
      if (index < records.length - 1 && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  } finally {
    await browser.close();
  }

  io.log(`Done: ${success} success, ${failed} failed.`);
  io.log(`Updated account list: ${options.outputPath}`);
  return {
    total: records.length,
    success,
    failed,
    outputPath: options.outputPath,
    statePath: options.statePath,
  };
}

module.exports = {
  DEFAULT_LOGIN_URL,
  DEFAULT_SETTINGS_URL,
  accountStatusFromError,
  checkAccounts,
  decodeBase32,
  defaultOutputPath,
  formatCredentialList,
  generatePassword,
  generateTotp,
  launchRotationBrowser,
  loginAccount,
  openAccountSettings,
  parseCredentialList,
  parseRotationArgs,
  rotateOneAccount,
  rotatePasswords,
  writePrivateAtomic,
  waitForPasswordUpdate,
};
