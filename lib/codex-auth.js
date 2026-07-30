"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_SETTINGS_URL,
  launchRotationBrowser,
  loginAccount,
  writePrivateAtomic,
} = require("./password-rotation");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE_TIMEOUT_MS = 60_000;

function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function profilesDir() {
  return path.resolve(
    process.env.CODEX_ACCOUNT_PROFILES || path.join(codexHome(), "profiles"),
  );
}

function authPath() {
  return path.join(codexHome(), "auth.json");
}

function codexBin() {
  return process.env.CODEX_ACCOUNT_CODEX_BIN || "codex";
}

function normalizeProfileName(profileName) {
  const value = String(profileName || "").trim();
  if (!value) {
    throw new Error("Codex auth profile name is required.");
  }
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("Codex auth profile name must be a file name, not a path.");
  }
  return value.endsWith(".json") ? value.slice(0, -5) : value;
}

function profilePath(profileName, directory = profilesDir()) {
  const name = normalizeProfileName(profileName);
  const root = path.resolve(directory);
  const resolved = path.resolve(root, `${name}.json`);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Codex auth profile must stay inside the profiles directory.");
  }
  return resolved;
}

function decodeJwtClaims(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractClaimsEmail(claims) {
  if (!claims || typeof claims !== "object") {
    return null;
  }
  const candidates = [
    claims.email,
    claims.user_email,
    claims["https://api.openai.com/profile"]?.email,
    claims["https://api.openai.com/auth"]?.email,
    claims["https://api.openai.com/auth"]?.user_email,
  ];
  const email = candidates.find((value) => typeof value === "string" && value.trim());
  return email ? email.trim() : null;
}

function extractAuthEmail(auth) {
  if (!auth || typeof auth !== "object") {
    return null;
  }
  return extractClaimsEmail(decodeJwtClaims(auth.tokens?.id_token))
    || extractClaimsEmail(decodeJwtClaims(auth.tokens?.access_token))
    || (typeof auth.email === "string" && auth.email.trim() ? auth.email.trim() : null);
}

function hashAuthContents(contents) {
  return crypto.createHash("sha256").update(String(contents).trim()).digest("hex");
}

function readAuthFile(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  let auth;
  try {
    auth = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
  return { auth, contents: contents.endsWith("\n") ? contents : `${contents}\n` };
}

function listAuthProfiles({
  directory = profilesDir(),
  activeFile = authPath(),
} = {}) {
  let activeHash = null;
  if (fs.existsSync(activeFile)) {
    try {
      activeHash = hashAuthContents(fs.readFileSync(activeFile, "utf8"));
    } catch {
      activeHash = null;
    }
  }
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const name = path.basename(entry.name, ".json");
      const stat = fs.statSync(filePath);
      try {
        const { auth, contents } = readAuthFile(filePath);
        return {
          name,
          fileName: entry.name,
          email: extractAuthEmail(auth),
          isCurrent: Boolean(activeHash && hashAuthContents(contents) === activeHash),
          modifiedAt: stat.mtime.toISOString(),
          valid: Boolean(auth.tokens?.access_token && auth.tokens?.refresh_token),
          error: null,
        };
      } catch (error) {
        return {
          name,
          fileName: entry.name,
          email: null,
          isCurrent: false,
          modifiedAt: stat.mtime.toISOString(),
          valid: false,
          error: error.message,
        };
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function profilesForEmail(email, profiles = listAuthProfiles()) {
  const key = String(email || "").trim().toLowerCase();
  return profiles.filter((profile) => profile.email?.toLowerCase() === key);
}

function defaultProfileName(email, profiles = listAuthProfiles()) {
  const base = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "account";
  const names = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  if (!names.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not choose an unused profile name for ${email}.`);
}

function preferredProfileForEmail(email, profiles = listAuthProfiles()) {
  const matches = profilesForEmail(email, profiles);
  return matches.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }
    const leftTemporary = /^temp(?:-|_|\d|$)/i.test(left.name);
    const rightTemporary = /^temp(?:-|_|\d|$)/i.test(right.name);
    if (leftTemporary !== rightTemporary) {
      return leftTemporary ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  })[0] || null;
}

function archiveAuthProfilesForEmail(email, {
  directory = profilesDir(),
} = {}) {
  const matches = profilesForEmail(email, listAuthProfiles({ directory }));
  if (matches.length === 0) {
    return [];
  }
  const archiveDirectory = path.join(directory, ".archive");
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(archiveDirectory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return matches.map((profile) => {
    const source = profilePath(profile.name, directory);
    let archiveName = `${stamp}-${profile.fileName}`;
    let destination = path.join(archiveDirectory, archiveName);
    for (let suffix = 2; fs.existsSync(destination); suffix += 1) {
      archiveName = `${stamp}-${suffix}-${profile.fileName}`;
      destination = path.join(archiveDirectory, archiveName);
    }
    fs.renameSync(source, destination);
    return {
      fileName: profile.fileName,
      archiveName,
    };
  });
}

function backupProfile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(backupPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  return backupPath;
}

function saveAuthProfile(contents, {
  profileName,
  expectedEmail,
  directory = profilesDir(),
} = {}) {
  let auth;
  try {
    auth = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Codex login produced invalid auth JSON: ${error.message}`);
  }
  if (!auth.tokens?.access_token || !auth.tokens?.refresh_token) {
    throw new Error("Codex login did not produce access and refresh tokens.");
  }
  const authEmail = extractAuthEmail(auth);
  if (
    expectedEmail
    && authEmail
    && authEmail.toLowerCase() !== String(expectedEmail).trim().toLowerCase()
  ) {
    throw new Error(
      `Codex auth belongs to ${authEmail}, not the requested account ${expectedEmail}.`,
    );
  }
  const destination = profilePath(profileName, directory);
  const backupPath = backupProfile(destination);
  writePrivateAtomic(destination, contents.endsWith("\n") ? contents : `${contents}\n`);
  return {
    name: path.basename(destination, ".json"),
    fileName: path.basename(destination),
    email: authEmail || String(expectedEmail || "").trim() || null,
    backupFileName: backupPath ? path.basename(backupPath) : null,
  };
}

function createTempCodexHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-auth-"));
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  return directory;
}

function spawnCodex(args, options) {
  return spawn(codexBin(), args, {
    ...options,
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function runCodexAuthLogin(codexHomeForLogin, {
  openLoginUrl,
  timeoutMs = LOGIN_TIMEOUT_MS,
  spawnCodexProcess = spawnCodex,
  onStep = () => {},
} = {}) {
  if (typeof openLoginUrl !== "function") {
    throw new Error("Codex auth login requires a browser automation callback.");
  }
  return new Promise((resolve, reject) => {
    const child = spawnCodexProcess([
      "app-server",
      "--stdio",
      "-c",
      "cli_auth_credentials_store=file",
    ], {
      env: {
        ...process.env,
        CODEX_HOME: codexHomeForLogin,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let loginId = null;
    let browserStarted = false;
    let loginCompleted = false;
    let settled = false;
    let stopping = false;
    let resultError = null;
    let forceKillTimer = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (resultError) {
        reject(resultError);
      } else {
        resolve();
      }
    };

    const stop = (error = null) => {
      if (settled || stopping) {
        return;
      }
      stopping = true;
      resultError = error;
      clearTimeout(timer);
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      forceKillTimer = setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }, 2000);
      forceKillTimer.unref();
    };

    const completeIfReady = () => {
      if (browserStarted && loginCompleted) {
        stop();
      }
    };

    const handleMessage = (message) => {
      if (message.id === 1 && message.error) {
        stop(new Error(`Codex app-server initialization failed: ${message.error.message}`));
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          stop(new Error(`Codex login failed: ${message.error.message}`));
          return;
        }
        const response = message.result || {};
        loginId = response.loginId;
        const loginUrl = response.authUrl || response.verificationUrl;
        if (!loginId || !loginUrl) {
          stop(new Error("Codex login did not return a login ID and browser URL."));
          return;
        }
        if (response.type === "chatgptDeviceCode") {
          stop(new Error("Automated dashboard auth does not support device-code login."));
          return;
        }
        browserStarted = true;
        onStep("Codex OAuth URL received; starting account login.");
        Promise.resolve()
          .then(() => openLoginUrl(loginUrl))
          .catch((error) => stop(error));
        completeIfReady();
        return;
      }
      if (message.method !== "account/login/completed") {
        return;
      }
      const params = message.params || {};
      if (loginId && params.loginId && params.loginId !== loginId) {
        return;
      }
      if (!params.success) {
        stop(new Error(`Codex login failed: ${params.error || "unknown error"}`));
        return;
      }
      loginCompleted = true;
      onStep("Codex app-server confirmed the OAuth login.");
      completeIfReady();
    };

    const timer = setTimeout(() => {
      stop(new Error("Timed out waiting for Codex auth login to complete."));
    }, timeoutMs);

    child.on("error", (error) => {
      resultError = new Error(`Failed to start ${codexBin()}: ${error.message}`);
      settle();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // Ignore non-protocol output from the child process.
        }
      }
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (stopping) {
        settle();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      resultError = new Error(`Codex app-server exited during login (${reason})${detail}`);
      settle();
    });

    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-acc",
          title: "Codex Account",
          version: require("../package.json").version,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "remoteControl/status/changed",
            "account/rateLimits/updated",
          ],
        },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      id: 2,
      method: "account/login/start",
      params: { type: "chatgpt" },
    })}\n`);
  });
}

async function completeCodexConsent(page, {
  timeoutMs = PAGE_TIMEOUT_MS,
  onStep = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = new URL(page.url());
    if (
      currentUrl.origin === "https://auth.openai.com"
      && currentUrl.pathname === "/sign-in-with-chatgpt/codex/consent"
    ) {
      const continueButton = page.getByRole("button", {
        name: "Continue",
        exact: true,
      });
      if (
        await continueButton.count() === 1
        && await continueButton.isVisible()
        && await continueButton.isEnabled()
      ) {
        onStep("Codex consent page detected; approving access for this account.");
        await continueButton.click({ timeout: timeoutMs });
        return true;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for the Codex OAuth consent page.");
}

async function acquireAuthProfile(account, {
  profileName,
  directory = profilesDir(),
  browserChannel = process.env.CODEX_ACCOUNT_BROWSER_CHANNEL || "chrome",
  browserExecutable = process.env.CODEX_ACCOUNT_BROWSER_EXECUTABLE || null,
  timeoutMs = PAGE_TIMEOUT_MS,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  spawnCodexProcess,
  browserFactory = launchRotationBrowser,
  login = loginAccount,
  consent = completeCodexConsent,
  onStep = () => {},
} = {}) {
  const email = String(account?.email || "").trim();
  const password = String(account?.password || "").trim();
  const mfaSecret = String(account?.mfaSecret || "").trim();
  if (!email || !password || !mfaSecret) {
    throw new Error("Email, password, and MFA secret are required to get Codex auth.");
  }
  const profiles = listAuthProfiles({ directory });
  const preferred = preferredProfileForEmail(email, profiles);
  const destinationName = profileName
    ? normalizeProfileName(profileName)
    : preferred?.name || defaultProfileName(email, profiles);
  const tempHome = createTempCodexHome();
  let browser = null;
  let context = null;
  try {
    onStep(`Getting Codex auth for ${email} into ${destinationName}.json.`);
    await runCodexAuthLogin(tempHome, {
      timeoutMs: loginTimeoutMs,
      spawnCodexProcess,
      onStep,
      openLoginUrl: async (loginUrl) => {
        browser = await browserFactory({
          browserChannel,
          browserExecutable,
        });
        context = await browser.newContext({ locale: "en-US" });
        const page = await context.newPage();
        const loginPromise = login(page, { email, password, mfaSecret }, {
          timeoutMs,
          manualTimeoutMs: timeoutMs,
          browserChannel,
          browserExecutable,
          unattended: true,
          verifyLogin: false,
          loginUrl,
          settingsUrl: DEFAULT_SETTINGS_URL,
          onStep,
        });
        const consentPromise = consent(page, { timeoutMs, onStep });
        await Promise.all([loginPromise, consentPromise]);
      },
    });
    const generatedAuthPath = path.join(tempHome, "auth.json");
    const { contents } = readAuthFile(generatedAuthPath);
    const saved = saveAuthProfile(contents, {
      profileName: destinationName,
      expectedEmail: email,
      directory,
    });
    onStep(`Saved Codex auth profile ${saved.fileName}.`);
    return saved;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    fs.rmSync(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

module.exports = {
  acquireAuthProfile,
  archiveAuthProfilesForEmail,
  authPath,
  codexHome,
  completeCodexConsent,
  decodeJwtClaims,
  defaultProfileName,
  extractAuthEmail,
  listAuthProfiles,
  normalizeProfileName,
  preferredProfileForEmail,
  profilePath,
  profilesDir,
  profilesForEmail,
  runCodexAuthLogin,
  saveAuthProfile,
};
