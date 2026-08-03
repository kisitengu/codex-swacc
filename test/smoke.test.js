const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.resolve(__dirname, "..", "bin", "codex-account.js");
const packageJson = require(path.resolve(__dirname, "..", "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-test-"));
const codexHome = path.join(root, ".codex");
const profiles = path.join(root, "profiles");
const mockCodexScript = path.join(root, "mock-codex.js");
const mockCodex = process.platform === "win32"
  ? path.join(root, "mock-codex.cmd")
  : mockCodexScript;
const mockBrowser = path.join(root, "mock-chrome.js");
const mockEdgeBrowser = path.join(root, "mock-msedge.js");
const mockBrowserLog = path.join(root, "mock-browser.log");
const mockOsascript = path.join(root, "mock-osascript.js");
const mockOpen = path.join(root, "mock-open.js");
const mockAppStopped = path.join(root, "mock-app-stopped");
const mockAppLog = path.join(root, "mock-app.log");
const mockPowershellScript = path.join(root, "mock-powershell.js");
const mockPowershell = mockPowershellScript;
const mockWindowsCodexScript = path.join(root, "mock-windows-codex.js");
const mockWindowsCodex = process.platform === "win32"
  ? path.join(root, "mock-windows-codex.cmd")
  : mockWindowsCodexScript;
const mockWindowsAppStopped = path.join(root, "mock-windows-app-stopped");
const mockWindowsAppLog = path.join(root, "mock-windows-app.log");
const mockCodexRequestLog = path.join(root, "mock-codex-requests.log");
const mockExhaustedRequestLog = path.join(root, "mock-exhausted-requests.log");
const mockQuotaBarrier = path.join(root, "mock-quota-barrier.log");

fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(profiles, { recursive: true });
fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ account: "old" }));
fs.writeFileSync(path.join(profiles, "personal.json"), JSON.stringify({ account: "personal" }));
fs.writeFileSync(path.join(profiles, "work.json"), JSON.stringify({ account: "work" }));
fs.writeFileSync(
  mockCodexScript,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function currentAccount() {
  return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "utf8")).account;
}

function hasConsumedReset(account) {
  if (!process.env.MOCK_CODEX_STATE || !fs.existsSync(process.env.MOCK_CODEX_STATE)) {
    return false;
  }
  return fs
    .readFileSync(process.env.MOCK_CODEX_STATE, "utf8")
    .split("\\n")
    .some((line) => line.split("\\t")[0] === account);
}

function recordConsumedReset(account, creditId) {
  if (process.env.MOCK_CODEX_STATE) {
    fs.appendFileSync(process.env.MOCK_CODEX_STATE, account + "\\t" + creditId + "\\n");
  }
}

function rateLimitResponse() {
  const account = currentAccount();
  const mode = process.env.MOCK_CODEX_MODE || "normal";
  const refreshed = hasConsumedReset(account);
  const depleted = mode === "depleted" && !refreshed;
  const exhausted = mode === "exhausted";
  const windowMode = process.env.MOCK_CODEX_WINDOW_MODE || "standard";
  const monthlyOnly = windowMode === "monthly-only";
  const usedPercent = depleted || exhausted ? 100 : refreshed ? 40 : 25;
  const resetCredits =
    mode === "exhausted" || refreshed
      ? { availableCount: 0, credits: [] }
      : { availableCount: 1, credits: [{ id: "credit-" + account, resetType: "reset", status: "available", grantedAt: 1893450000, expiresAt: 1896048000, title: "Reset", description: "Reset quota" }] };
  return { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent, windowDurationMins: monthlyOnly ? 43200 : 10080, resetsAt: 1893456000 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "10" }, individualLimit: null, planType: "plus", rateLimitReachedType: usedPercent >= 100 ? "primary_window" : null }, rateLimitsByLimitId: null, rateLimitResetCredits: resetCredits };
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (process.env.MOCK_CODEX_REQUEST_LOG) {
      fs.appendFileSync(process.env.MOCK_CODEX_REQUEST_LOG, message.method + "\\n");
    }
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: { userAgent: "mock", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "test" } }));
    }
    if (message.method === "account/login/start") {
      if (process.env.MOCK_CODEX_LOGIN_RECORD) {
        fs.writeFileSync(
          process.env.MOCK_CODEX_LOGIN_RECORD,
          JSON.stringify({
            args: process.argv.slice(2),
            request: message,
            codexHome: process.env.CODEX_HOME,
          }),
        );
      }
      if (process.env.MOCK_CODEX_LOGIN_MODE === "fail") {
        console.log(JSON.stringify({ id: message.id, error: { message: "mock login failure" } }));
        continue;
      }

      const deviceAuth = message.params?.type === "chatgptDeviceCode";
      const loginId = deviceAuth ? "device-login" : "browser-login";
      const result = deviceAuth
        ? {
            type: "chatgptDeviceCode",
            loginId,
            verificationUrl: "https://auth.example.test/device",
            userCode: "ABCD-1234",
          }
        : {
            type: "chatgpt",
            loginId,
            authUrl: "https://auth.example.test/oauth",
          };
      console.log(JSON.stringify({ id: message.id, result }));
      setTimeout(() => {
        if (process.env.MOCK_CODEX_LOGIN_MODE !== "missing-auth") {
          fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
          fs.writeFileSync(
            path.join(process.env.CODEX_HOME, "auth.json"),
            JSON.stringify({ account: process.env.MOCK_CODEX_LOGIN_ACCOUNT || "logged-in" }),
          );
        }
        console.log(JSON.stringify({
          method: "account/login/completed",
          params: { loginId, success: true, error: null },
        }));
      }, 10);
    }
    if (message.method === "account/rateLimits/read") {
      if (process.env.MOCK_CODEX_ROTATE_TOKEN === "1") {
        const authPath = path.join(process.env.CODEX_HOME, "auth.json");
        const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
        fs.writeFileSync(
          authPath,
          JSON.stringify({
            ...auth,
            tokenVersion: Number(auth.tokenVersion || 0) + 1,
          }),
        );
      }
      const respond = () => console.log(JSON.stringify({ id: message.id, result: rateLimitResponse() }));
      const barrierCount = Number(process.env.MOCK_CODEX_BARRIER_COUNT || 0);
      if (!barrierCount) {
        respond();
        continue;
      }

      fs.appendFileSync(process.env.MOCK_CODEX_BARRIER_FILE, currentAccount() + "\\n");
      const deadline = Date.now() + 3000;
      const timer = setInterval(() => {
        const arrivals = fs
          .readFileSync(process.env.MOCK_CODEX_BARRIER_FILE, "utf8")
          .trim()
          .split("\\n")
          .filter(Boolean);
        if (arrivals.length >= barrierCount) {
          clearInterval(timer);
          respond();
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          process.exit(9);
        }
      }, 10);
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      if (!message.params?.creditId || !message.params?.idempotencyKey) {
        console.log(JSON.stringify({ id: message.id, error: { message: "missing reset params" } }));
        continue;
      }
      recordConsumedReset(currentAccount(), message.params.creditId);
      console.log(JSON.stringify({ id: message.id, result: { outcome: "reset" } }));
    }
    if (message.method === "account/usage/read") {
      console.log(JSON.stringify({ id: message.id, result: { summary: { lifetimeTokens: 1000, peakDailyTokens: 500, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 3 }, dailyUsageBuckets: [{ startDate: "2026-07-08", tokens: 123 }] } }));
    }
  }
});
`,
);
fs.chmodSync(mockCodexScript, 0o700);

fs.writeFileSync(
  mockBrowser,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(
  process.env.MOCK_BROWSER_LOG,
  JSON.stringify(process.argv.slice(2)) + "\\n",
);
`,
);
fs.chmodSync(mockBrowser, 0o700);

fs.writeFileSync(
  mockEdgeBrowser,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(
  process.env.MOCK_BROWSER_LOG,
  JSON.stringify(process.argv.slice(2)) + "\\n",
);
`,
);
fs.chmodSync(mockEdgeBrowser, 0o700);

fs.writeFileSync(
  mockOsascript,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
const stoppedFile = ${JSON.stringify(mockAppStopped)};
const logFile = ${JSON.stringify(mockAppLog)};

if (args.includes("is running")) {
  console.log(fs.existsSync(stoppedFile) ? "false" : "true");
  process.exit(0);
}

if (args.includes("to quit")) {
  fs.appendFileSync(logFile, "quit\\n");
  fs.writeFileSync(stoppedFile, "stopped");
  process.exit(0);
}

process.exit(2);
`,
);
fs.chmodSync(mockOsascript, 0o700);

fs.writeFileSync(
  mockOpen,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(mockAppLog)}, "open " + process.argv.slice(2).join(" ") + "\\n");
`,
);
fs.chmodSync(mockOpen, 0o700);

fs.writeFileSync(
  mockPowershellScript,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
const stoppedFile = ${JSON.stringify(mockWindowsAppStopped)};
const logFile = ${JSON.stringify(mockWindowsAppLog)};

if (args.includes("CloseMainWindow")) {
  fs.appendFileSync(logFile, "quit\\n");
  fs.writeFileSync(stoppedFile, "stopped");
  process.exit(0);
}

if (args.includes("MainWindowHandle")) {
  console.log(fs.existsSync(stoppedFile) ? "false" : "true");
  process.exit(0);
}

process.exit(2);
`,
);
fs.chmodSync(mockPowershellScript, 0o700);

fs.writeFileSync(
  mockWindowsCodexScript,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(mockWindowsAppLog)}, "codex " + process.argv.slice(2).join(" ") + "\\n");
`,
);
fs.chmodSync(mockWindowsCodexScript, 0o700);

if (process.platform === "win32") {
  fs.writeFileSync(
    mockCodex,
    `@ECHO OFF\r\n"${process.execPath}" "${mockCodexScript}" %*\r\n`,
  );
  fs.writeFileSync(
    mockWindowsCodex,
    `@ECHO OFF\r\n"${process.execPath}" "${mockWindowsCodexScript}" %*\r\n`,
  );
}

function waitForFileMatch(filePath, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && pattern.test(fs.readFileSync(filePath, "utf8"))) {
      return;
    }
    Atomics.wait(waiter, 0, 0, 25);
  }
  assert.fail(`Timed out waiting for ${pattern} in ${filePath}`);
}

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_ACCOUNT_PROFILES: profiles,
      CODEX_ACCOUNT_CODEX_BIN: mockCodex,
      CODEX_ACCOUNT_BROWSER_BIN: mockBrowser,
      CODEX_ACCOUNT_RESTART_APP: "0",
      MOCK_BROWSER_LOG: mockBrowserLog,
      ...extraEnv,
    },
  });
}

assert.deepEqual(packageJson.bin, {
  "codex-acc": "bin/codex-account.js",
});
assert.deepEqual(packageJson.pnpm?.onlyBuiltDependencies, [
  "better-sqlite3",
]);

const list = run(["list"]);
assert.equal(list.status, 0, list.stderr);
assert.deepEqual(list.stdout.trim().split("\n"), ["personal", "work"]);

const use = run(["use", "work"]);
assert.equal(use.status, 0, use.stderr);
assert.match(use.stdout, /Switched Codex auth to profile: work/);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")), {
  account: "work",
});
assert.equal(
  fs.readdirSync(codexHome).filter((file) => file.startsWith("auth.json.backup-")).length,
  1,
);

const current = run(["current"]);
assert.equal(current.status, 0, current.stderr);
assert.match(current.stdout, /Current profile: work/);

if (process.platform !== "win32") {
  const restartUse = run(["use", "work"], {
    CODEX_ACCOUNT_RESTART_APP: "1",
    CODEX_ACCOUNT_TEST_PLATFORM: "darwin",
    CODEX_ACCOUNT_OSASCRIPT_BIN: mockOsascript,
    CODEX_ACCOUNT_OPEN_BIN: mockOpen,
  });
  assert.equal(restartUse.status, 0, restartUse.stderr);
  assert.match(restartUse.stdout, /Restarting Codex App to load the new account/);
  waitForFileMatch(mockAppLog, /open -b com\.openai\.codex/);
  assert.match(fs.readFileSync(mockAppLog, "utf8"), /^quit$/m);
}

const restartWindowsUse = run(["use", "work"], {
  CODEX_ACCOUNT_RESTART_APP: "1",
  CODEX_ACCOUNT_TEST_PLATFORM: "win32",
  CODEX_ACCOUNT_POWERSHELL_BIN: mockPowershell,
  CODEX_ACCOUNT_CODEX_BIN: mockWindowsCodex,
});
assert.equal(restartWindowsUse.status, 0, restartWindowsUse.stderr);
assert.match(restartWindowsUse.stdout, /Restarting Codex App to load the new account/);
waitForFileMatch(mockWindowsAppLog, /codex app/);
assert.match(fs.readFileSync(mockWindowsAppLog, "utf8"), /^quit$/m);

const saveExisting = run(["save", "work"]);
assert.notEqual(saveExisting.status, 0);
assert.match(saveExisting.stderr, /Profile already exists/);

const saveNew = run(["save", "copied"]);
assert.equal(saveNew.status, 0, saveNew.stderr);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profiles, "copied.json"), "utf8")), {
  account: "work",
});

const quota = run(["quota"], {
  MOCK_CODEX_REQUEST_LOG: mockCodexRequestLog,
});
assert.equal(quota.status, 0, quota.stderr);
assert.match(quota.stdout, /copied\s+week \[###############-----\]\s+75% <- best week/);
assert.match(quota.stdout, /^\s+resets 1 \(next expires 2030-01-31 00:00 UTC\)$/m);
assert.match(quota.stdout, /personal\s+week \[###############-----\]\s+75%/);
assert.match(quota.stdout, /work\s+week \[###############-----\]\s+75%/);
assert.doesNotMatch(quota.stdout, /\b5h\b/);
const quotaMethods = fs.readFileSync(mockCodexRequestLog, "utf8").trim().split("\n");
assert.equal(quotaMethods.filter((method) => method === "account/rateLimits/read").length, 3);
assert.equal(quotaMethods.includes("account/usage/read"), false);

const quotaWithSpinner = run(["quota"], {
  CODEX_ACCOUNT_FORCE_SPINNER: "1",
});
assert.equal(quotaWithSpinner.status, 0, quotaWithSpinner.stderr);
assert.match(quotaWithSpinner.stderr, /Checking account quotas/);

const monthlyOnlyQuota = run(["quota", "--json"], {
  MOCK_CODEX_WINDOW_MODE: "monthly-only",
});
assert.equal(monthlyOnlyQuota.status, 0, monthlyOnlyQuota.stderr);
assert.deepEqual(JSON.parse(monthlyOnlyQuota.stdout)[0].otherWindows, [
  { durationMins: 43200, remainingPercent: 75 },
]);

const concurrentQuota = run(["quota"], {
  CODEX_ACCOUNT_QUOTA_CONCURRENCY: "3",
  MOCK_CODEX_BARRIER_COUNT: "3",
  MOCK_CODEX_BARRIER_FILE: mockQuotaBarrier,
});
assert.equal(concurrentQuota.status, 0, concurrentQuota.stderr);
assert.doesNotMatch(concurrentQuota.stdout, /error -/);

const invalidQuotaConcurrency = run(["quota"], {
  CODEX_ACCOUNT_QUOTA_CONCURRENCY: "0",
});
assert.notEqual(invalidQuotaConcurrency.status, 0);
assert.match(invalidQuotaConcurrency.stderr, /must be a positive integer/);

const quotaWithProfile = run(["quota", "work"]);
assert.notEqual(quotaWithProfile.status, 0);
assert.match(quotaWithProfile.stderr, /quota now checks every JSON profile/);

const quotaJson = run(["quota", "--json"]);
assert.equal(quotaJson.status, 0, quotaJson.stderr);
const quotaJsonRows = JSON.parse(quotaJson.stdout);
assert.deepEqual(quotaJsonRows.map((row) => row.profile), ["copied", "personal", "work"]);
assert.deepEqual(quotaJsonRows[0], {
  profile: "copied",
  weekRemainingPercent: 75,
  resetCreditsAvailable: 1,
  resetCreditsNextExpiry: "2030-01-31T00:00:00.000Z",
});

const quotaWithRotatedAuth = run(["quota", "--json"], {
  MOCK_CODEX_ROTATE_TOKEN: "1",
});
assert.equal(quotaWithRotatedAuth.status, 0, quotaWithRotatedAuth.stderr);
for (const profile of ["copied", "personal", "work"]) {
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profiles, `${profile}.json`), "utf8")).tokenVersion,
    1,
    `quota should persist refreshed auth for ${profile}`,
  );
}

const sw = run(["sw"]);
assert.equal(sw.status, 0, sw.stderr);
assert.match(sw.stdout, /Best profile: copied \(week\s+75%\)/);
assert.match(sw.stdout, /Switched Codex auth to profile: copied/);

const monthlyOnlySw = run(["sw"], {
  MOCK_CODEX_WINDOW_MODE: "monthly-only",
});
assert.equal(monthlyOnlySw.status, 0, monthlyOnlySw.stderr);
assert.match(monthlyOnlySw.stdout, /Best profile: copied \(30d\s+75%\)/);

const refreshState = path.join(root, "refresh-state.json");
const depletedSw = run(["sw"], {
  MOCK_CODEX_MODE: "depleted",
  MOCK_CODEX_STATE: refreshState,
});
assert.equal(depletedSw.status, 0, depletedSw.stderr);
assert.match(depletedSw.stdout, /All profiles are out of week quota\. Refreshing quota/);
assert.match(depletedSw.stdout, /Refreshed quota for copied \(reset\)/);
assert.match(depletedSw.stdout, /Best profile: copied \(week\s+60%\)/);
assert.match(depletedSw.stdout, /Switched Codex auth to profile: copied/);

const exhaustedSw = run(["sw"], {
  MOCK_CODEX_MODE: "exhausted",
  MOCK_CODEX_REQUEST_LOG: mockExhaustedRequestLog,
});
assert.notEqual(exhaustedSw.status, 0);
assert.match(exhaustedSw.stdout, /All profiles are out of week quota\. Refreshing quota/);
assert.match(exhaustedSw.stdout, /copied: No reset credits available/);
assert.match(exhaustedSw.stderr, /All profiles are still out of week quota after refresh/);
const exhaustedMethods = fs.readFileSync(mockExhaustedRequestLog, "utf8").trim().split("\n");
assert.equal(exhaustedMethods.filter((method) => method === "account/rateLimits/read").length, 3);

const authBeforeAdd = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8");
const loginRecord = path.join(root, "login-record.json");
const add = run(["add", "new-account"], {
  MOCK_CODEX_LOGIN_ACCOUNT: "new-account",
  MOCK_CODEX_LOGIN_RECORD: loginRecord,
});
assert.equal(add.status, 0, add.stderr);
assert.match(add.stdout, /Added Codex profile: new-account/);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(profiles, "new-account.json"), "utf8")),
  { account: "new-account" },
);
assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), authBeforeAdd);
if (process.platform !== "win32") {
  assert.equal(fs.statSync(path.join(profiles, "new-account.json")).mode & 0o777, 0o600);
}
const addRecord = JSON.parse(fs.readFileSync(loginRecord, "utf8"));
assert.deepEqual(addRecord.args, [
  "app-server",
  "--stdio",
  "-c",
  "cli_auth_credentials_store=file",
]);
assert.deepEqual(addRecord.request, {
  id: 2,
  method: "account/login/start",
  params: { type: "chatgpt" },
});
assert.equal(fs.existsSync(addRecord.codexHome), false);
waitForFileMatch(mockBrowserLog, /auth\.example\.test\/oauth/);
const browserLaunchesAfterAdd = fs
  .readFileSync(mockBrowserLog, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(browserLaunchesAfterAdd.at(-1), [
  "--incognito",
  "--new-window",
  "https://auth.example.test/oauth",
]);

const deviceAdd = run(["login", "device-account", "--device-auth"], {
  CODEX_ACCOUNT_BROWSER_BIN: mockEdgeBrowser,
  MOCK_CODEX_LOGIN_ACCOUNT: "device-account",
  MOCK_CODEX_LOGIN_RECORD: loginRecord,
});
assert.equal(deviceAdd.status, 0, deviceAdd.stderr);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(profiles, "device-account.json"), "utf8")),
  { account: "device-account" },
);
const deviceRecord = JSON.parse(fs.readFileSync(loginRecord, "utf8"));
assert.equal(deviceRecord.request.params.type, "chatgptDeviceCode");
assert.equal(fs.existsSync(deviceRecord.codexHome), false);
assert.match(deviceAdd.stdout, /Device authentication code: ABCD-1234/);
waitForFileMatch(mockBrowserLog, /auth\.example\.test\/device/);
const browserLaunchesAfterDeviceAdd = fs
  .readFileSync(mockBrowserLog, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(browserLaunchesAfterDeviceAdd.at(-1), [
  "--inprivate",
  "--new-window",
  "https://auth.example.test/device",
]);

const failedAdd = run(["add", "failed-account"], {
  MOCK_CODEX_LOGIN_MODE: "fail",
});
assert.notEqual(failedAdd.status, 0);
assert.match(failedAdd.stderr, /Codex login failed: mock login failure/);
assert.equal(fs.existsSync(path.join(profiles, "failed-account.json")), false);

const missingAuthAdd = run(["add", "missing-auth"], {
  MOCK_CODEX_LOGIN_MODE: "missing-auth",
});
assert.notEqual(missingAuthAdd.status, 0);
assert.match(missingAuthAdd.stderr, /File not found: .*auth\.json/);
assert.equal(fs.existsSync(path.join(profiles, "missing-auth.json")), false);

const overwriteAdd = run(["add", "work"]);
assert.notEqual(overwriteAdd.status, 0);
assert.match(overwriteAdd.stderr, /Profile already exists/);

const unknownAddOption = run(["add", "another-account", "--unknown"]);
assert.notEqual(unknownAddOption.status, 0);
assert.match(unknownAddOption.stderr, /Unknown add option: --unknown/);

const syncHome = path.join(root, "sync-home");
const syncProfiles = path.join(root, "sync-profiles");
fs.mkdirSync(syncHome, { recursive: true });
fs.mkdirSync(syncProfiles, { recursive: true });
fs.writeFileSync(
  path.join(syncHome, "auth.json"),
  JSON.stringify({
    tokens: {
      account_id: "account-to-sync",
      access_token: "new-access",
      refresh_token: "new-refresh",
    },
    last_refresh: "2030-01-02T00:00:00.000Z",
  }),
);
fs.writeFileSync(
  path.join(syncProfiles, "current-account.json"),
  JSON.stringify({
    tokens: {
      account_id: "account-to-sync",
      access_token: "old-access",
      refresh_token: "old-refresh",
    },
    last_refresh: "2030-01-01T00:00:00.000Z",
  }),
);
fs.writeFileSync(
  path.join(syncProfiles, "next-account.json"),
  JSON.stringify({ account: "next-account" }),
);
const syncedUse = run(["use", "next-account"], {
  CODEX_HOME: syncHome,
  CODEX_ACCOUNT_PROFILES: syncProfiles,
});
assert.equal(syncedUse.status, 0, syncedUse.stderr);
assert.equal(
  JSON.parse(
    fs.readFileSync(path.join(syncProfiles, "current-account.json"), "utf8"),
  ).tokens.refresh_token,
  "new-refresh",
);

console.log("smoke test passed");
