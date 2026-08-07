#!/usr/bin/env node

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI_NAME = "codex-acc";
const CLI_VERSION = require(path.join(__dirname, "..", "package.json")).version;
const WEEK_WINDOW_MINS = 10080;
const IGNORED_QUOTA_WINDOW_MINS = [300];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CODEX_APP_BUNDLE_ID = "com.openai.codex";
const WINDOWS_CODEX_APP_FILTER = [
  "| Where-Object {",
  "$_.ProcessName -eq 'ChatGPT'",
  "-or $_.MainWindowHandle -ne 0",
  "-or ($_.Path -and $_.Path -like '*\\WindowsApps\\*')",
  "}",
].join(" ");
const WINDOWS_CODEX_APP_QUERY = [
  "$process = Get-Process -Name 'ChatGPT','Codex' -ErrorAction SilentlyContinue",
  WINDOWS_CODEX_APP_FILTER,
  "| Select-Object -First 1;",
  "if ($null -ne $process) { 'true' } else { 'false' }",
].join(" ");
const WINDOWS_CODEX_APP_QUIT = [
  "$processes = @(Get-Process -Name 'ChatGPT','Codex' -ErrorAction SilentlyContinue",
  `${WINDOWS_CODEX_APP_FILTER});`,
  "foreach ($process in $processes) { $null = $process.CloseMainWindow() };",
  "if ($processes.Count -gt 0) {",
  "Wait-Process -Id $processes.Id -Timeout 5 -ErrorAction SilentlyContinue;",
  "$remaining = @($processes | Where-Object { -not $_.HasExited });",
  "if ($remaining.Count -gt 0) {",
  "$remaining | Stop-Process -Force -ErrorAction SilentlyContinue",
  "}",
  "}",
].join(" ");
const WINDOWS_DEFAULT_BROWSER_QUERY = [
  "$userChoice = Get-ItemProperty -LiteralPath",
  "'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'",
  "-ErrorAction SilentlyContinue;",
  "if ($null -ne $userChoice -and $userChoice.ProgId) {",
  '$key = "Registry::HKEY_CLASSES_ROOT\\$($userChoice.ProgId)\\shell\\open\\command";',
  "$command = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)';",
  "if ($command) {",
  "$expanded = [Environment]::ExpandEnvironmentVariables($command);",
  `if ($expanded -match '^\\s*"([^"]+\\.exe)"') { $Matches[1] }`,
  `elseif ($expanded -match '^\\s*(.+?\\.exe)(?:\\s|$)') { $Matches[1].Trim('"') }`,
  "}",
  "}",
].join(" ");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function usage() {
  console.log(`Usage:
  ${CLI_NAME} list
  ${CLI_NAME} current
  ${CLI_NAME} use <profile>
  ${CLI_NAME} save <profile>
  ${CLI_NAME} add <profile> [--device-auth]
  ${CLI_NAME} quota [--json]
  ${CLI_NAME} sw
  ${CLI_NAME} rotate-passwords <accounts.txt> [options]
  ${CLI_NAME} db [accounts.txt] [options]

Password rotation:
  Input format: email|current-password|MFA-secret
  --output <file>          Private output list with the new passwords.
  --password-length <n>    Generated password length. Default: 24.
  --skip-verify            Skip the verification login after each change.
  --continue-on-error      Continue after failures that happened before submit.
  --unattended             Never wait for manual browser interaction.
  --resume                 Resume from the output state checkpoint.
  --dry-run                Validate input only; do not open a browser.
  --yes                    Skip the interactive confirmation.

Dashboard:
  Defaults to the private SQLite database at ~/.codex/accounts.sqlite3.
  --db <file>              Use a different SQLite database.
  --port <n>               Local port. Default: 0 (random available port).
  --no-open                Start the server without opening a browser.

Profiles:
  Stored in: ${profilesDir()}
  Example profile name: work -> ${path.join(profilesDir(), "work.json")}

Environment:
  CODEX_HOME               Override Codex config directory. Default: ~/.codex
  CODEX_ACCOUNT_PROFILES   Override profiles directory.
  CODEX_ACCOUNT_CODEX_BIN  Override codex executable. Default: codex
  CODEX_ACCOUNT_BROWSER_BIN
                           Override the browser used for private login windows.
  CODEX_ACCOUNT_QUOTA_CONCURRENCY
                           Maximum parallel quota checks. Default: 5
  CODEX_ACCOUNT_RESTART_APP
                           Set to 0 to disable automatic app restart on macOS/Windows.
  CODEX_ACCOUNT_BROWSER_CHANNEL
                           Playwright browser channel. Default: chrome
  CODEX_ACCOUNT_BROWSER_EXECUTABLE
                           Full path to Chrome/Edge/Chromium.
`);
}

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

function quotaConcurrency() {
  const raw = process.env.CODEX_ACCOUNT_QUOTA_CONCURRENCY;
  if (raw === undefined) {
    return 5;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error("CODEX_ACCOUNT_QUOTA_CONCURRENCY must be a positive integer");
  }

  return Math.min(Number(raw), 32);
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function createSpinner(message) {
  const forceSpinner = process.env.CODEX_ACCOUNT_FORCE_SPINNER === "1";
  if (!process.stderr.isTTY && !forceSpinner) {
    return { stop() {} };
  }

  let frameIndex = 0;
  const render = () => {
    process.stderr.write(`\r${SPINNER_FRAMES[frameIndex]} ${message}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, 80);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\x1b[2K");
    },
  };
}

async function withLoading(message, action) {
  const spinner = createSpinner(message);
  try {
    return await action();
  } finally {
    spinner.stop();
  }
}

function spawnCodex(args, options) {
  return spawn(codexBin(), args, {
    ...options,
    // On Windows, globally installed npm CLIs are usually .cmd shims. Running
    // them through cmd.exe lets `codex` resolve the same way it does in a
    // PowerShell or Command Prompt session.
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function shouldRestartCodexApp() {
  const value = process.env.CODEX_ACCOUNT_RESTART_APP;
  if (value === undefined) {
    return true;
  }

  return !new Set(["0", "false", "no", "off"]).has(value.trim().toLowerCase());
}

function osascriptBin() {
  return process.env.CODEX_ACCOUNT_OSASCRIPT_BIN || "/usr/bin/osascript";
}

function openBin() {
  return process.env.CODEX_ACCOUNT_OPEN_BIN || "/usr/bin/open";
}

function powershellBin() {
  return process.env.CODEX_ACCOUNT_POWERSHELL_BIN || "powershell.exe";
}

function effectivePlatform() {
  return process.env.CODEX_ACCOUNT_TEST_PLATFORM || process.platform;
}

function appLaunchEnvironment() {
  const env = { ...process.env };
  delete env.CODEX_HOME;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_ACCOUNT_")) {
      delete env[key];
    }
  }
  return env;
}

function powershellArgs(script) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const runJavaScript = process.platform === "win32" && /\.js$/i.test(command);
    const child = spawn(runJavaScript ? process.execPath : command, [
      ...(runJavaScript ? [command] : []),
      ...args,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(new Error(`Failed to start ${command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish(new Error(`${command} failed (${reason})${detail}`));
    });
  });
}

async function isMacCodexAppRunning() {
  const result = await runCommand(osascriptBin(), [
    "-e",
    `application id "${CODEX_APP_BUNDLE_ID}" is running`,
  ]);
  return result.stdout.trim().toLowerCase() === "true";
}

function scheduleDetachedHelper(command, args) {
  return new Promise((resolve, reject) => {
    const helper = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: appLaunchEnvironment(),
      windowsHide: true,
    });

    helper.once("error", (error) => {
      reject(new Error(`Failed to schedule Codex App reopen: ${error.message}`));
    });
    helper.once("spawn", () => {
      helper.unref();
      resolve();
    });
  });
}

function scheduleMacCodexAppReopen() {
  const helperScript = `
attempt=0
while [ "$("$1" -e 'application id "${CODEX_APP_BUNDLE_ID}" is running' 2>/dev/null)" = "true" ] && [ "$attempt" -lt 40 ]; do
  /bin/sleep 0.25
  attempt=$((attempt + 1))
done
/bin/sleep 0.25
exec "$2" -b "$3"
`;

  return scheduleDetachedHelper("/bin/sh", [
    "-c",
    helperScript,
    "codex-acc-restart",
    osascriptBin(),
    openBin(),
    CODEX_APP_BUNDLE_ID,
  ]);
}

async function isWindowsCodexAppRunning() {
  const result = await runCommand(
    powershellBin(),
    powershellArgs(WINDOWS_CODEX_APP_QUERY),
  );
  return result.stdout.trim().toLowerCase() === "true";
}

function scheduleWindowsCodexAppReopen() {
  const helperScript = `
const { spawn, spawnSync } = require("node:child_process");
const [powershell, codex, query] = process.argv.slice(1);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

(async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0 || result.stdout.trim().toLowerCase() !== "true") {
      break;
    }
    await wait(250);
  }

  await wait(250);
  const app = spawn(codex, ["app"], {
    detached: true,
    shell: true,
    stdio: "ignore",
    windowsHide: true,
  });
  app.on("error", () => {});
  app.unref();
})().catch(() => {});
`;

  return scheduleDetachedHelper(process.execPath, [
    "-e",
    helperScript,
    powershellBin(),
    codexBin(),
    WINDOWS_CODEX_APP_QUERY,
  ]);
}

async function restartCodexAppIfRunning() {
  const platform = effectivePlatform();
  if (!new Set(["darwin", "win32"]).has(platform) || !shouldRestartCodexApp()) {
    return;
  }

  let isRunning;
  try {
    isRunning = await withLoading("Checking Codex App status...", () => (
      platform === "darwin"
        ? isMacCodexAppRunning()
        : isWindowsCodexAppRunning()
    ));
  } catch (error) {
    console.error(`Warning: Could not check Codex App status: ${error.message}`);
    return;
  }

  if (!isRunning) {
    return;
  }

  console.log("Restarting Codex App to load the new account...");
  try {
    if (platform === "darwin") {
      await scheduleMacCodexAppReopen();
    } else {
      await scheduleWindowsCodexAppReopen();
    }
  } catch (error) {
    console.error(`Warning: ${error.message}. Restart Codex App manually.`);
    return;
  }

  try {
    if (platform === "darwin") {
      await runCommand(osascriptBin(), [
        "-e",
        `tell application id "${CODEX_APP_BUNDLE_ID}" to quit`,
      ]);
    } else {
      await runCommand(powershellBin(), powershellArgs(WINDOWS_CODEX_APP_QUIT));
    }
  } catch (error) {
    console.error(`Warning: Could not quit Codex App: ${error.message}`);
  }
}

function fail(message, exitCode = 1) {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function profilePath(profileName) {
  if (!profileName) {
    fail("Missing profile name.");
  }

  if (profileName.includes("/") || profileName.includes("\\") || profileName === "." || profileName === "..") {
    fail("Profile name must be a file name, not a path.");
  }

  const fileName = profileName.endsWith(".json") ? profileName : `${profileName}.json`;
  const resolved = path.resolve(profilesDir(), fileName);
  const root = path.resolve(profilesDir());
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    fail("Profile name must stay inside the profiles directory.");
  }
  return resolved;
}

function readJsonFile(filePath) {
  try {
    return readJsonFileOrThrow(filePath);
  } catch (error) {
    fail(error.message);
  }
}

function readJsonFileOrThrow(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }

  try {
    JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }

  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort. Some filesystems do not support chmod.
  }
}

function writePrivateFileAtomic(filePath, contents) {
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
      // Best effort. Some filesystems do not support chmod.
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

function writeNewProfile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filePath, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Profile already exists: ${filePath}`);
    }
    throw error;
  }

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort. Some filesystems do not support chmod.
  }
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupCurrentAuth() {
  const target = authPath();
  if (!fs.existsSync(target)) {
    return null;
  }

  const backupPath = path.join(codexHome(), `auth.json.backup-${timestamp()}`);
  fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(backupPath, 0o600);
  } catch {
    // Best effort. Some filesystems do not support chmod.
  }
  return backupPath;
}

function listProfiles() {
  const profiles = getProfileNames();
  const dir = profilesDir();

  if (profiles === null) {
    console.log(`No profiles directory found: ${dir}`);
    return;
  }

  if (profiles.length === 0) {
    console.log(`No profiles found in: ${dir}`);
    return;
  }

  for (const profile of profiles) {
    console.log(profile);
  }
}

function getProfileNames() {
  const dir = profilesDir();
  if (!fs.existsSync(dir)) {
    return null;
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.basename(entry.name, ".json"))
    .sort((a, b) => a.localeCompare(b));
}

function createTempCodexHome(authContents) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-"));
  fs.chmodSync(tempHome, 0o700);
  if (authContents !== undefined) {
    writePrivateFile(path.join(tempHome, "auth.json"), authContents);
  }
  return tempHome;
}

function removeTempCodexHome(tempHome) {
  fs.rmSync(tempHome, {
    recursive: true,
    force: true,
    // Codex can briefly retain plugin/cache handles after app-server exits.
    // Windows reports those as EBUSY/EPERM, so allow fs.rmSync to retry.
    maxRetries: 10,
    retryDelay: 100,
  });
}

function persistTempAuthToProfile(tempHome, profileName) {
  const temporaryAuthPath = path.join(tempHome, "auth.json");
  if (!fs.existsSync(temporaryAuthPath)) {
    return false;
  }
  const refreshedContents = readJsonFileOrThrow(temporaryAuthPath);
  const destination = profilePath(profileName);
  const existingContents = readJsonFileOrThrow(destination);
  if (sha256(refreshedContents) === sha256(existingContents)) {
    return false;
  }
  writePrivateFileAtomic(destination, refreshedContents);
  return true;
}

async function withProfileCodexHome(profileName, operation) {
  const tempHome = createTempCodexHome(
    readJsonFileOrThrow(profilePath(profileName)),
  );
  let operationError = null;
  try {
    return await operation(tempHome);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let persistenceError = null;
    try {
      persistTempAuthToProfile(tempHome, profileName);
    } catch (error) {
      persistenceError = error;
    }
    removeTempCodexHome(tempHome);
    if (!operationError && persistenceError) {
      throw persistenceError;
    }
  }
}

function authRefreshTime(auth) {
  const timestampValue = Date.parse(auth?.last_refresh);
  return Number.isFinite(timestampValue) ? timestampValue : null;
}

function syncActiveAuthToProfiles() {
  const activeFile = authPath();
  const profileNames = getProfileNames();
  if (!fs.existsSync(activeFile) || !profileNames || profileNames.length === 0) {
    return [];
  }

  let activeContents;
  let activeAuth;
  try {
    activeContents = readJsonFileOrThrow(activeFile);
    activeAuth = JSON.parse(activeContents);
  } catch {
    return [];
  }
  const accountId = activeAuth.tokens?.account_id;
  const activeRefreshTime = authRefreshTime(activeAuth);
  if (typeof accountId !== "string" || !accountId || activeRefreshTime === null) {
    return [];
  }

  const synced = [];
  for (const profileName of profileNames) {
    const destination = profilePath(profileName);
    let profileContents;
    let profileAuth;
    try {
      profileContents = readJsonFileOrThrow(destination);
      profileAuth = JSON.parse(profileContents);
    } catch {
      continue;
    }
    if (
      profileAuth.tokens?.account_id !== accountId
      || sha256(profileContents) === sha256(activeContents)
    ) {
      continue;
    }
    const profileRefreshTime = authRefreshTime(profileAuth);
    if (
      profileRefreshTime !== null
      && profileRefreshTime > activeRefreshTime
    ) {
      continue;
    }
    writePrivateFileAtomic(destination, activeContents);
    synced.push(profileName);
  }
  return synced;
}

function privateBrowserArgs(browserPath, url) {
  const browserName = path.basename(browserPath).toLowerCase();

  if (browserName.includes("firefox")) {
    return ["-private-window", url];
  }

  if (browserName.includes("msedge")) {
    return ["--inprivate", "--new-window", url];
  }

  if (
    ["chrome", "chromium", "brave"].some((name) =>
      browserName.includes(name)
    )
  ) {
    return ["--incognito", "--new-window", url];
  }

  return null;
}

function resolveExecutableOnPath(executable) {
  if (!executable) {
    return null;
  }

  if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    const resolved = path.resolve(executable);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(executable) !== "";
  const extensions =
    process.platform === "win32" && !hasExtension
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${executable}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function supportedBrowserPath(candidate) {
  const resolved = resolveExecutableOnPath(candidate);
  return resolved && privateBrowserArgs(resolved, "https://example.com")
    ? resolved
    : null;
}

async function resolvePrivateBrowser() {
  const configured = process.env.CODEX_ACCOUNT_BROWSER_BIN;
  if (configured) {
    const resolved = supportedBrowserPath(configured);
    if (!resolved) {
      throw new Error(
        `CODEX_ACCOUNT_BROWSER_BIN must point to Chrome, Edge, Brave, Firefox, ` +
          `or Chromium: ${configured}`,
      );
    }
    return resolved;
  }

  const platform = effectivePlatform();
  const candidates = [];

  if (platform === "win32") {
    try {
      const result = await runCommand(
        powershellBin(),
        powershellArgs(WINDOWS_DEFAULT_BROWSER_QUERY),
      );
      const defaultBrowser = result.stdout.trim().split(/\r?\n/).find(Boolean);
      if (defaultBrowser) {
        candidates.push(defaultBrowser);
      }
    } catch {
      // Fall back to common browser install locations below.
    }

    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    candidates.push(
      localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData &&
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      localAppData &&
        path.join(
          localAppData,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe",
        ),
      programFiles &&
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 &&
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      programFiles &&
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      programFilesX86 &&
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      programFiles &&
        path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      programFiles && path.join(programFiles, "Mozilla Firefox", "firefox.exe"),
      programFilesX86 && path.join(programFilesX86, "Mozilla Firefox", "firefox.exe"),
      "chrome",
      "msedge",
      "brave",
      "firefox",
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
      "firefox",
    );
  }

  for (const candidate of candidates.filter(Boolean)) {
    const resolved = supportedBrowserPath(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "No supported browser was found for private login. " +
      "Set CODEX_ACCOUNT_BROWSER_BIN to Chrome, Edge, Brave, Firefox, Chromium, " +
      "or Chromium.",
  );
}

function launchPrivateBrowser(browserPath, url) {
  if (!/^https?:\/\//i.test(url)) {
    return Promise.reject(new Error(`Refusing to open an invalid login URL: ${url}`));
  }

  const args = privateBrowserArgs(browserPath, url);
  if (!args) {
    return Promise.reject(new Error(`Unsupported private browser: ${browserPath}`));
  }

  return new Promise((resolve, reject) => {
    const runJavaScript = process.platform === "win32" && /\.js$/i.test(browserPath);
    const child = spawn(runJavaScript ? process.execPath : browserPath, [
      ...(runJavaScript ? [browserPath] : []),
      ...args,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to open a private browser window: ${error.message}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function runCodexLogin(codexHomeForLogin, deviceAuth = false) {
  let browserPath = null;
  try {
    browserPath = await resolvePrivateBrowser();
  } catch (error) {
    if (process.env.CODEX_ACCOUNT_BROWSER_BIN) {
      throw error;
    }
    console.error(`Warning: ${error.message}`);
    console.error("The login URL will be printed so you can open it in a private window.");
  }

  return new Promise((resolve, reject) => {
    const child = spawnCodex([
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
    let browserOpened = browserPath === null;
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
      if (browserOpened && loginCompleted) {
        stop();
      }
    };

    const handleMessage = async (message) => {
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
          console.log(`Device authentication code: ${response.userCode}`);
        }
        if (browserPath) {
          console.log(
            `Opening ${path.basename(browserPath)} in a private window...`,
          );
          console.log(`If it did not open, paste this URL into a private window: ${loginUrl}`);
          await launchPrivateBrowser(browserPath, loginUrl);
          browserOpened = true;
        } else {
          console.log(`Open this URL in a private browser window: ${loginUrl}`);
        }
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
      completeIfReady();
    };

    const timer = setTimeout(() => {
      stop(new Error("Timed out waiting for Codex login to complete."));
    }, LOGIN_TIMEOUT_MS);

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

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        handleMessage(message).catch((error) => stop(error));
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

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: CLI_NAME,
            title: "Codex Account",
            version: CLI_VERSION,
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
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        id: 2,
        method: "account/login/start",
        params: {
          type: deviceAuth ? "chatgptDeviceCode" : "chatgpt",
        },
      })}\n`,
    );
  });
}

async function addProfile(profileName, args) {
  const destination = profilePath(profileName);
  if (fs.existsSync(destination)) {
    fail(`Profile already exists: ${destination}`);
  }

  const allowedArgs = new Set(["--device-auth"]);
  const unknownArg = args.find((arg) => !allowedArgs.has(arg));
  if (unknownArg) {
    fail(`Unknown add option: ${unknownArg}`);
  }

  let tempHome = null;
  try {
    tempHome = createTempCodexHome();
    console.log(`Log in to Codex for profile: ${path.basename(destination, ".json")}`);
    await runCodexLogin(tempHome, args.includes("--device-auth"));

    const contents = readJsonFileOrThrow(path.join(tempHome, "auth.json"));
    writeNewProfile(destination, contents);
    console.log(`Added Codex profile: ${path.basename(destination, ".json")}`);
    console.log(`Wrote: ${destination}`);
  } finally {
    if (tempHome) {
      removeTempCodexHome(tempHome);
    }
  }
}

function callCodexAppServer(codexHomeForCall, requests, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawnCodex(["app-server", "--stdio"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHomeForCall,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map(requests.map((request) => [request.id, request.method]));
    const results = new Map();
    let stdoutBuffer = "";
    let stderr = "";
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
        resolve(results);
      }
    };

    const stop = (error = null) => {
      if (settled || stopping) {
        return;
      }
      stopping = true;
      resultError = error;
      clearTimeout(timer);

      // app-server exits cleanly when its stdio input reaches EOF. Waiting for
      // "close" is important on Windows: killing the cmd.exe npm shim only
      // terminates the wrapper and can leave codex.exe holding temp files.
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

    const timer = setTimeout(() => {
      const waiting = [...pending.values()].join(", ");
      stop(new Error(`Timed out waiting for Codex app-server response: ${waiting}`));
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

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (!pending.has(message.id)) {
          continue;
        }

        pending.delete(message.id);
        if (message.error) {
          results.set(message.id, { error: message.error });
        } else {
          results.set(message.id, message.result);
        }

        if (pending.size === 0) {
          stop();
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
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      resultError = new Error(
        `Codex app-server exited before responding (${signal || code})${detail}`,
      );
      settle();
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: CLI_NAME,
            title: "Codex Account",
            version: CLI_VERSION,
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
      })}\n`,
    );

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

async function readQuotaForCodexHome(codexHomeForCall) {
  const responses = await callCodexAppServer(codexHomeForCall, [
    { id: 2, method: "account/rateLimits/read" },
  ]);

  const rateLimits = responses.get(2);
  if (rateLimits?.error) {
    throw new Error(`account/rateLimits/read failed: ${formatAppServerError(rateLimits.error)}`);
  }

  return { rateLimits };
}

async function consumeResetCreditForCodexHome(codexHomeForCall, quota) {
  const resetCredits = quota.rateLimits?.rateLimitResetCredits;
  if (!resetCredits || resetCredits.availableCount <= 0) {
    return { consumed: false, message: "No reset credits available" };
  }

  const credit = Array.isArray(resetCredits.credits) ? resetCredits.credits[0] : null;
  const creditId = resetCreditId(credit);
  if (!creditId) {
    return { consumed: false, message: "Reset credit is available but no credit id was returned" };
  }

  const responses = await callCodexAppServer(codexHomeForCall, [
    {
      id: 2,
      method: "account/rateLimitResetCredit/consume",
      params: {
        creditId,
        idempotencyKey: crypto.randomUUID(),
      },
    },
  ]);

  const result = responses.get(2);
  if (result?.error) {
    throw new Error(`account/rateLimitResetCredit/consume failed: ${formatAppServerError(result.error)}`);
  }

  return { consumed: true, outcome: result?.outcome || "unknown" };
}

function resetCreditId(credit) {
  if (!credit || typeof credit !== "object") {
    return null;
  }

  return credit.id || credit.creditId || credit.credit_id || credit.goal || credit.resetType || credit.reset_type || null;
}

function formatAppServerError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error?.message) {
    return error.message;
  }
  return JSON.stringify(error);
}

function remainingPercent(window) {
  if (!window || typeof window.usedPercent !== "number" || Number.isNaN(window.usedPercent)) {
    return null;
  }
  return Math.max(0, Math.round(100 - window.usedPercent));
}

function quotaWindowCandidates(quota) {
  const response = quota.rateLimits;
  const defaultLimits = response?.rateLimits;
  const candidates = [defaultLimits?.primary, defaultLimits?.secondary];
  for (const limits of Object.values(response?.rateLimitsByLimitId || {})) {
    candidates.push(limits?.primary, limits?.secondary);
  }

  return candidates.filter((window, index) => (
    window
    && typeof window === "object"
    && candidates.indexOf(window) === index
  ));
}

function quotaWindowByDuration(quota, durationMins) {
  return quotaWindowCandidates(quota).find(
    (window) => typeof window.windowDurationMins === "number"
      && quotaWindowDurationMatches(window.windowDurationMins, durationMins),
  ) || null;
}

function quotaWindowDurationMatches(actualMins, expectedMins) {
  return Math.abs(actualMins - expectedMins) <= expectedMins * 0.1;
}

function otherQuotaWindows(quota) {
  const seenDurations = new Set();
  return quotaWindowCandidates(quota).filter((window) => {
    const duration = window.windowDurationMins;
    if (typeof duration !== "number" || seenDurations.has(duration)) {
      return false;
    }
    seenDurations.add(duration);
    if (IGNORED_QUOTA_WINDOW_MINS.some(
      (ignored) => quotaWindowDurationMatches(duration, ignored),
    )) {
      return false;
    }
    return !quotaWindowDurationMatches(duration, WEEK_WINDOW_MINS);
  });
}

function formatWindowDuration(durationMins) {
  if (durationMins % 1440 === 0) {
    return `${durationMins / 1440}d`;
  }
  if (durationMins % 60 === 0) {
    return `${durationMins / 60}h`;
  }
  return `${durationMins}m`;
}

function quotaWindowRemaining(quota, durationMins) {
  return remainingPercent(quotaWindowByDuration(quota, durationMins));
}

function resetCreditInfo(quota) {
  const resetCredits = quota.rateLimits?.rateLimitResetCredits;
  const availableCount = typeof resetCredits?.availableCount === "number"
    ? resetCredits.availableCount
    : null;
  const credits = Array.isArray(resetCredits?.credits) ? resetCredits.credits : [];
  const expiryTimes = credits
    .filter((credit) => !credit.status || credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter((expiresAt) => typeof expiresAt === "number" && Number.isFinite(expiresAt));

  return {
    availableCount,
    nextExpiry: expiryTimes.length > 0 ? Math.min(...expiryTimes) : null,
  };
}

function formatResetExpiry(epochSeconds) {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatResetCreditInfo(quota) {
  const info = resetCreditInfo(quota);
  const count = info.availableCount === null ? "??" : info.availableCount;
  const expiry = info.nextExpiry === null
    ? ""
    : ` (next expires ${formatResetExpiry(info.nextExpiry)})`;
  return `resets ${count}${expiry}`;
}

function quotaSelectionMetric(rows) {
  const successful = rows.filter((row) => row.quota);
  if (successful.some((row) => quotaWindowRemaining(row.quota, WEEK_WINDOW_MINS) !== null)) {
    return { durationMins: WEEK_WINDOW_MINS, label: "week" };
  }

  const fallbackDuration = successful
    .flatMap((row) => otherQuotaWindows(row.quota))
    .map((window) => window.windowDurationMins)
    .sort((left, right) => left - right)
    .find((durationMins) => successful.some(
      (row) => quotaWindowRemaining(row.quota, durationMins) !== null,
    ));

  return fallbackDuration === undefined
    ? null
    : { durationMins: fallbackDuration, label: formatWindowDuration(fallbackDuration) };
}

function quotaScore(quota, metric) {
  return quotaWindowRemaining(quota, metric.durationMins) ?? -1;
}

function printQuotaSummary(rows) {
  const successful = rows.filter((row) => row.quota);
  const metric = quotaSelectionMetric(successful);
  const best = selectBestQuotaRow(successful, metric);

  for (const row of rows) {
    if (row.error) {
      console.log(`${row.profile}: error - ${row.error.message}`);
      continue;
    }

    const week = quotaWindowRemaining(row.quota, WEEK_WINDOW_MINS);
    const otherWindows = otherQuotaWindows(row.quota)
      .map((window) => {
        const remaining = remainingPercent(window);
        return `${formatWindowDuration(window.windowDurationMins)} ${formatBar(remaining)} ${formatRemaining(remaining)}`;
      })
      .join("  ");
    const otherSummary = otherWindows ? `  ${otherWindows}` : "";
    const marker = best?.profile === row.profile ? ` <- best ${metric.label}` : "";
    console.log(
      `${row.profile.padEnd(18)} week ${formatBar(week)} ${formatRemaining(week)}${otherSummary}${marker}`,
    );
    console.log(`${"".padEnd(20)}${formatResetCreditInfo(row.quota)}`);
  }
}

function formatRemaining(value) {
  return value === null ? "??%" : `${String(value).padStart(3)}%`;
}

function formatBar(value, width = 20) {
  if (value === null) {
    return `[${"?".repeat(width)}]`;
  }

  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function selectBestQuotaRow(rows, metric = quotaSelectionMetric(rows)) {
  if (!metric) {
    return null;
  }

  const usable = rows.filter(
    (row) => row.quota && quotaWindowRemaining(row.quota, metric.durationMins) !== null,
  );
  if (usable.length === 0) {
    return null;
  }

  return usable.reduce(
    (winner, row) => (quotaScore(row.quota, metric) > quotaScore(winner.quota, metric) ? row : winner),
  );
}

function selectBestAvailableQuotaRow(rows, metric = quotaSelectionMetric(rows)) {
  if (!metric) {
    return null;
  }

  const usable = rows.filter((row) => {
    const remaining = row.quota ? quotaWindowRemaining(row.quota, metric.durationMins) : null;
    return remaining !== null && remaining > 0;
  });
  if (usable.length === 0) {
    return null;
  }

  return usable.reduce(
    (winner, row) => (quotaScore(row.quota, metric) > quotaScore(winner.quota, metric) ? row : winner),
  );
}

function allUsableQuotasDepleted(rows, metric = quotaSelectionMetric(rows)) {
  if (!metric) {
    return false;
  }

  const usable = rows.filter(
    (row) => row.quota && quotaWindowRemaining(row.quota, metric.durationMins) !== null,
  );
  return usable.length > 0
    && usable.every((row) => quotaWindowRemaining(row.quota, metric.durationMins) <= 0);
}

function toQuotaSummaryJson(row) {
  const resetCredits = row.quota ? resetCreditInfo(row.quota) : null;
  const summary = {
    profile: row.profile,
    weekRemainingPercent: row.quota ? quotaWindowRemaining(row.quota, WEEK_WINDOW_MINS) : null,
    resetCreditsAvailable: resetCredits?.availableCount ?? null,
    resetCreditsNextExpiry: resetCredits?.nextExpiry
      ? new Date(resetCredits.nextExpiry * 1000).toISOString()
      : null,
    error: row.error?.message,
  };
  const otherWindows = row.quota ? otherQuotaWindows(row.quota) : [];
  if (otherWindows.length > 0) {
    summary.otherWindows = otherWindows.map((window) => ({
      durationMins: window.windowDurationMins,
      remainingPercent: remainingPercent(window),
    }));
  }
  return summary;
}

async function readProfileQuotas(profiles) {
  return mapWithConcurrency(profiles, quotaConcurrency(), async (profile) => {
    try {
      const quota = await withProfileCodexHome(
        profile,
        (tempHome) => readQuotaForCodexHome(tempHome),
      );
      return { profile, quota };
    } catch (error) {
      return { profile, error: { message: error.message } };
    }
  });
}

async function readAllProfileQuotas() {
  syncActiveAuthToProfiles();
  const profiles = getProfileNames();
  if (profiles === null || profiles.length === 0) {
    fail(`No profiles found in: ${profilesDir()}`);
  }

  return readProfileQuotas(profiles);
}

async function refreshDepletedProfileQuotas(rows) {
  const metric = quotaSelectionMetric(rows);
  if (!metric) {
    return [];
  }

  const depletedRows = rows.filter((row) => {
    const remaining = row.quota ? quotaWindowRemaining(row.quota, metric.durationMins) : null;
    return remaining !== null && remaining <= 0;
  });

  return mapWithConcurrency(depletedRows, quotaConcurrency(), async (row) => {
    const resetCredits = row.quota.rateLimits?.rateLimitResetCredits;
    if (!resetCredits || resetCredits.availableCount <= 0) {
      return { profile: row.profile, consumed: false, message: "No reset credits available" };
    }

    try {
      const result = await withProfileCodexHome(
        row.profile,
        (tempHome) => consumeResetCreditForCodexHome(tempHome, row.quota),
      );
      return { profile: row.profile, ...result };
    } catch (error) {
      return { profile: row.profile, consumed: false, message: error.message };
    }
  });
}

async function updateRefreshedQuotaRows(rows, refreshResults) {
  const refreshedProfiles = refreshResults
    .filter((result) => result.consumed)
    .map((result) => result.profile);
  if (refreshedProfiles.length === 0) {
    return rows;
  }

  const refreshedRows = await readProfileQuotas(refreshedProfiles);
  const refreshedByProfile = new Map(refreshedRows.map((row) => [row.profile, row]));
  return rows.map((row) => refreshedByProfile.get(row.profile) || row);
}

function printRefreshResults(results) {
  if (results.length === 0) {
    console.log("No depleted profiles could be refreshed.");
    return;
  }

  for (const result of results) {
    if (result.consumed) {
      console.log(`Refreshed quota for ${result.profile} (${result.outcome})`);
    } else {
      console.log(`${result.profile}: ${result.message}`);
    }
  }
}

async function quotaCommand(args) {
  const allowedArgs = new Set(["--json", "--all"]);
  const unknownArg = args.find((arg) => !allowedArgs.has(arg));
  if (unknownArg) {
    fail(`quota now checks every JSON profile. Run: ${CLI_NAME} quota`);
  }

  const rows = await withLoading("Checking account quotas...", () => readAllProfileQuotas());
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows.map(toQuotaSummaryJson), null, 2));
  } else {
    printQuotaSummary(rows);
  }
}

async function swCommand() {
  let rows = await withLoading("Checking account quotas...", () => readAllProfileQuotas());
  let metric = quotaSelectionMetric(rows);
  let best = selectBestAvailableQuotaRow(rows, metric);
  if (!best && allUsableQuotasDepleted(rows, metric)) {
    console.log(`All profiles are out of ${metric.label} quota. Refreshing quota...`);
    const refreshResults = await withLoading(
      "Refreshing depleted quotas...",
      () => refreshDepletedProfileQuotas(rows),
    );
    printRefreshResults(refreshResults);
    rows = await withLoading(
      "Checking refreshed quotas...",
      () => updateRefreshedQuotaRows(rows, refreshResults),
    );
    metric = quotaSelectionMetric(rows);
    best = selectBestAvailableQuotaRow(rows, metric);
    if (!best && allUsableQuotasDepleted(rows, metric)) {
      fail(`All profiles are still out of ${metric.label} quota after refresh. No switch was made.`);
    }
  }

  if (!best) {
    const errors = rows
      .filter((row) => row.error)
      .map((row) => `${row.profile}: ${row.error.message}`)
      .join("\n");
    fail(`Could not find a usable profile quota.${errors ? `\n${errors}` : ""}`);
  }

  const remaining = quotaWindowRemaining(best.quota, metric.durationMins);
  console.log(
    `Best profile: ${best.profile} (${metric.label} ${formatRemaining(remaining)})`,
  );
  await useProfile(best.profile);
}

async function useProfile(profileName) {
  syncActiveAuthToProfiles();
  const source = profilePath(profileName);
  const contents = readJsonFile(source);
  const backupPath = backupCurrentAuth();
  writePrivateFile(authPath(), contents);

  console.log(`Switched Codex auth to profile: ${path.basename(source, ".json")}`);
  console.log(`Wrote: ${authPath()}`);
  if (backupPath) {
    console.log(`Backup: ${backupPath}`);
  }
  await restartCodexAppIfRunning();
}

function currentProfile() {
  const target = authPath();
  if (!fs.existsSync(target)) {
    console.log(`No Codex auth file found: ${target}`);
    return;
  }

  const authContents = fs.readFileSync(target, "utf8");
  const authHash = sha256(authContents.trim());
  const dir = profilesDir();

  if (!fs.existsSync(dir)) {
    console.log("Current profile: unknown");
    console.log(`Auth: ${target}`);
    console.log(`Profiles directory missing: ${dir}`);
    return;
  }

  const matches = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => {
      const candidate = fs.readFileSync(path.join(dir, entry.name), "utf8");
      return sha256(candidate.trim()) === authHash;
    })
    .map((entry) => path.basename(entry.name, ".json"))
    .sort((a, b) => a.localeCompare(b));

  if (matches.length === 0) {
    console.log("Current profile: unknown");
    return;
  }

  console.log(`Current profile: ${matches.join(", ")}`);
}

function saveProfile(profileName) {
  const target = authPath();
  if (!fs.existsSync(target)) {
    fail(`No Codex auth file found: ${target}`);
  }

  const destination = profilePath(profileName);
  if (fs.existsSync(destination)) {
    fail(`Profile already exists: ${destination}`);
  }

  const contents = readJsonFile(target);
  writeNewProfile(destination, contents);
  console.log(`Saved current Codex auth to profile: ${path.basename(destination, ".json")}`);
  console.log(`Wrote: ${destination}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const profileName = args[0];

  switch (command) {
    case "list":
    case "ls":
      listProfiles();
      break;
    case "current":
      currentProfile();
      break;
    case "use":
      await useProfile(profileName);
      break;
    case "save":
      saveProfile(profileName);
      break;
    case "add":
    case "login":
      await addProfile(profileName, args.slice(1));
      break;
    case "quota":
    case "usage":
    case "limits":
      await quotaCommand(args);
      break;
    case "sw":
      await swCommand();
      break;
    case "rotate-passwords":
    case "rotate-pass":
      await require("../lib/password-rotation").rotatePasswords(args);
      break;
    case "db":
      await require("../lib/dashboard").startDashboard(parseDashboardArgs(args));
      break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      usage();
      fail(`Unknown command: ${command}`);
  }
}

function parseDashboardArgs(args) {
  let filePath = null;
  let dbPath;
  let port = 0;
  let open = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      open = false;
      continue;
    }
    if (argument === "--port") {
      const value = args[index + 1];
      if (value === undefined) {
        fail("Missing value for --port.");
      }
      port = value;
      index += 1;
      continue;
    }
    if (argument === "--db") {
      const value = args[index + 1];
      if (value === undefined) {
        fail("Missing value for --db.");
      }
      dbPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      fail(`Unknown dashboard option: ${argument}`);
    }
    if (filePath) {
      fail(`Unexpected dashboard argument: ${argument}`);
    }
    filePath = argument;
  }
  if (filePath && dbPath) {
    fail("Use either an account list or --db, not both.");
  }
  return { filePath, dbPath, port, open };
}

main().catch((error) => {
  fail(error.message || String(error));
});
