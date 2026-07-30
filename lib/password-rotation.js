"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const DEFAULT_LOGIN_URL = "https://chatgpt.com/auth/login";
const DEFAULT_SETTINGS_URL = "https://chatgpt.com/#settings/Account";
const DEFAULT_PASSWORD_LENGTH = 24;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 300_000;
const DEFAULT_DELAY_MS = 2_000;
const STATE_VERSION = 1;

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
    const password = originalLine.slice(firstSeparator + 1, lastSeparator);
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
    headless: false,
    dryRun: false,
    yes: false,
    resume: false,
    continueOnError: false,
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
    ["--headless", ["headless", true]],
    ["--dry-run", ["dryRun", true]],
    ["--yes", ["yes", true]],
    ["--resume", ["resume", true]],
    ["--continue-on-error", ["continueOnError", true]],
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

function visible(locator) {
  return locator.count().then(async (count) => {
    if (count !== 1) {
      return false;
    }
    return locator.isVisible();
  });
}

async function findVisible(page, candidates) {
  for (const candidate of candidates) {
    const locator = candidate(page);
    if (await visible(locator)) {
      return locator;
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
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const detail = lastError ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
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
  return current.origin === settings.origin
    && !(current.origin === login.origin && current.pathname === login.pathname);
}

async function clickContinue(page) {
  const button = await findVisible(page, [
    (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
    (scope) => scope.getByRole("button", { name: "Verify", exact: true }),
    (scope) => scope.getByRole("button", { name: "Log in", exact: true }),
    (scope) => scope.locator('button[type="submit"]'),
  ]);
  if (!button) {
    throw new Error("Could not find the login submit button.");
  }
  await button.click();
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
  await page.goto(options.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });

  const emailInput = await waitForValue(
    () => findVisible(page, [
      (scope) => scope.getByRole("textbox", { name: "Email address", exact: true }),
      (scope) => scope.getByLabel("Email address", { exact: true }),
      (scope) => scope.locator('input[type="email"]'),
    ]),
    options.timeoutMs,
    "the email field",
  );
  await emailInput.fill(account.email);
  await clickContinue(page);

  const passwordInput = await waitForValue(
    async () => {
      const errorText = await pageText(page);
      if (/invalid email|could not find|try again/i.test(errorText)) {
        throw new Error("The login page rejected the email address.");
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
  await passwordInput.fill(account.password);
  await clickContinue(page);

  const loginResult = await waitForValue(
    async () => {
      if (loginCompleted(page, options)) {
        return "complete";
      }
      const text = await pageText(page);
      if (/wrong password|incorrect password|invalid credentials|email or password is incorrect/i.test(text)) {
        throw new Error("The current password was rejected.");
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
    await loginResult.fill(await waitForFreshTotp(account.mfaSecret));
    await clickContinue(page);
  } else if (options.headless) {
    throw new Error("The account requested verification but no MFA secret was supplied.");
  }

  try {
    await waitForValue(
      () => (loginCompleted(page, options) ? true : null),
      options.timeoutMs,
      "login completion",
    );
  } catch (error) {
    if (options.headless) {
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
    (scope) => scope.getByRole("button", { name: "Update password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Change password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Add password", exact: true }),
    (scope) => scope.getByText("Update password", { exact: true }),
    (scope) => scope.getByText("Change password", { exact: true }),
    (scope) => scope.getByText("Add password", { exact: true }),
  ]);
}

async function openAccountSettings(page, options) {
  await page.goto(options.settingsUrl, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });

  let action = await passwordAction(page);
  if (action) {
    return action;
  }

  const profileMenu = await findVisible(page, [
    (scope) => scope.getByRole("button", { name: "Open profile menu", exact: true }),
    (scope) => scope.getByRole("button", { name: "Profile", exact: true }),
    (scope) => scope.getByRole("button", { name: "Account menu", exact: true }),
    (scope) => scope.locator('button[data-testid="profile-button"]'),
  ]);
  if (profileMenu) {
    await profileMenu.click();
    const settings = await waitForValue(
      () => findVisible(page, [
        (scope) => scope.getByRole("menuitem", { name: "Settings", exact: true }),
        (scope) => scope.getByRole("button", { name: "Settings", exact: true }),
        (scope) => scope.getByText("Settings", { exact: true }),
      ]),
      options.timeoutMs,
      "the Settings menu item",
    );
    await settings.click();
  }

  const accountTab = await findVisible(page, [
    (scope) => scope.getByRole("tab", { name: "Account", exact: true }),
    (scope) => scope.getByRole("button", { name: "Account", exact: true }),
    (scope) => scope.getByText("Account", { exact: true }),
  ]);
  if (accountTab) {
    await accountTab.click();
  }

  action = await waitForValue(
    () => passwordAction(page),
    options.timeoutMs,
    "Add, Update, or Change password in Settings > Account",
  );
  return action;
}

async function fillPasswordForm(page, account, newPassword, options) {
  const passwordInputs = page.locator('input[type="password"]');
  await waitForValue(
    async () => ((await passwordInputs.count()) >= 1 ? true : null),
    options.timeoutMs,
    "the password update form",
  );

  const currentInput = await findVisible(page, [
    (scope) => scope.getByLabel("Current password", { exact: true }),
    (scope) => scope.locator('input[autocomplete="current-password"]'),
    (scope) => scope.locator('input[name="currentPassword"]'),
  ]);
  if (currentInput) {
    await currentInput.fill(account.password);
  }

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

  if (!newInput || !confirmInput) {
    throw new Error("Could not identify the new-password and confirmation fields.");
  }

  await newInput.fill(newPassword);
  await confirmInput.fill(newPassword);

  const submit = await findVisible(page, [
    (scope) => scope.getByRole("button", { name: "Update password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Change password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Save password", exact: true }),
    (scope) => scope.getByRole("button", { name: "Save", exact: true }),
    (scope) => scope.getByRole("button", { name: "Continue", exact: true }),
    (scope) => scope.locator('button[type="submit"]'),
  ]);
  if (!submit) {
    throw new Error("Could not find the final password update button.");
  }
  await submit.click();
}

async function waitForPasswordUpdate(page, options) {
  return waitForValue(
    async () => {
      const text = await pageText(page);
      if (/password (has been |was )?(updated|changed|set)|successfully (updated|changed)/i.test(text)) {
        return true;
      }
      if (/unable to update|could not update|password.*error|try again/i.test(text)) {
        throw new Error("ChatGPT reported that the password update failed.");
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
    await loginAccount(page, account, options);
    const action = await openAccountSettings(page, options);
    await action.click();
    await fillPasswordForm(page, account, newPassword, options);
    submitted = true;
    await onSubmitted();
    await waitForPasswordUpdate(page, options);
  } catch (error) {
    error.passwordSubmitted = submitted;
    throw error;
  } finally {
    await context.close();
  }

  if (!options.verifyLogin) {
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

async function launchRotationBrowser(options) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error(
      "Browser automation dependency is missing. Run npm install --global switch-codex-accounts again.",
    );
  }

  const launchOptions = {
    headless: options.headless,
  };
  if (options.browserExecutable) {
    launchOptions.executablePath = options.browserExecutable;
  } else if (options.browserChannel) {
    launchOptions.channel = options.browserChannel;
  }

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    throw new Error(
      `Could not launch ${options.browserExecutable || options.browserChannel}: ${error.message}. `
      + "Install Google Chrome, or set CODEX_ACCOUNT_BROWSER_EXECUTABLE.",
    );
  }
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
        if (submitted) {
          io.error(
            `  The final form was submitted. Keep the new password from ${options.outputPath} and verify this account manually.`,
          );
        }
        if (!options.continueOnError || submitted) {
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
