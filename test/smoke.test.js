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
const mockCodex = path.join(root, "mock-codex.js");

fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(profiles, { recursive: true });
fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ account: "old" }));
fs.writeFileSync(path.join(profiles, "personal.json"), JSON.stringify({ account: "personal" }));
fs.writeFileSync(path.join(profiles, "work.json"), JSON.stringify({ account: "work" }));
fs.writeFileSync(
  mockCodex,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function currentAccount() {
  return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "utf8")).account;
}

function readState() {
  if (!process.env.MOCK_CODEX_STATE || !fs.existsSync(process.env.MOCK_CODEX_STATE)) {
    return { consumed: {} };
  }
  return JSON.parse(fs.readFileSync(process.env.MOCK_CODEX_STATE, "utf8"));
}

function writeState(state) {
  if (process.env.MOCK_CODEX_STATE) {
    fs.writeFileSync(process.env.MOCK_CODEX_STATE, JSON.stringify(state));
  }
}

function rateLimitResponse() {
  const account = currentAccount();
  const mode = process.env.MOCK_CODEX_MODE || "normal";
  const state = readState();
  const refreshed = Boolean(state.consumed[account]);
  const depleted = mode === "depleted" && !refreshed;
  const exhausted = mode === "exhausted";
  const usedPercent = depleted || exhausted ? 100 : refreshed ? 40 : 25;
  const resetCredits =
    mode === "exhausted" || refreshed
      ? { availableCount: 0, credits: [] }
      : { availableCount: 1, credits: [{ id: "credit-" + account, resetType: "reset", grantedAt: 1893450000, expiresAt: null, title: "Reset", description: "Reset quota" }] };
  return { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: 1893456000 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1893888000 }, credits: { hasCredits: true, unlimited: false, balance: "10" }, individualLimit: null, planType: "plus", rateLimitReachedType: usedPercent >= 100 ? "primary_window" : null }, rateLimitsByLimitId: null, rateLimitResetCredits: resetCredits };
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
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: { userAgent: "mock", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "test" } }));
    }
    if (message.method === "account/rateLimits/read") {
      console.log(JSON.stringify({ id: message.id, result: rateLimitResponse() }));
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      if (!message.params?.creditId || !message.params?.idempotencyKey) {
        console.log(JSON.stringify({ id: message.id, error: { message: "missing reset params" } }));
        continue;
      }
      const state = readState();
      state.consumed[currentAccount()] = message.params.creditId;
      writeState(state);
      console.log(JSON.stringify({ id: message.id, result: { outcome: "reset" } }));
    }
    if (message.method === "account/usage/read") {
      console.log(JSON.stringify({ id: message.id, result: { summary: { lifetimeTokens: 1000, peakDailyTokens: 500, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 3 }, dailyUsageBuckets: [{ startDate: "2026-07-08", tokens: 123 }] } }));
    }
  }
});
`,
);
fs.chmodSync(mockCodex, 0o700);

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_ACCOUNT_PROFILES: profiles,
      CODEX_ACCOUNT_CODEX_BIN: mockCodex,
      ...extraEnv,
    },
  });
}

assert.deepEqual(packageJson.bin, {
  "codex-acc": "bin/codex-account.js",
});

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

const saveExisting = run(["save", "work"]);
assert.notEqual(saveExisting.status, 0);
assert.match(saveExisting.stderr, /Profile already exists/);

const saveNew = run(["save", "copied"]);
assert.equal(saveNew.status, 0, saveNew.stderr);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profiles, "copied.json"), "utf8")), {
  account: "work",
});

const quota = run(["quota"]);
assert.equal(quota.status, 0, quota.stderr);
assert.match(quota.stdout, /copied\s+5h \[###############-----\]\s+75%  week \[##########----------\]\s+50% <- best 5h/);
assert.match(quota.stdout, /personal\s+5h \[###############-----\]\s+75%  week \[##########----------\]\s+50%/);
assert.match(quota.stdout, /work\s+5h \[###############-----\]\s+75%  week \[##########----------\]\s+50%/);

const quotaWithProfile = run(["quota", "work"]);
assert.notEqual(quotaWithProfile.status, 0);
assert.match(quotaWithProfile.stderr, /quota now checks every JSON profile/);

const quotaJson = run(["quota", "--json"]);
assert.equal(quotaJson.status, 0, quotaJson.stderr);
const quotaJsonRows = JSON.parse(quotaJson.stdout);
assert.deepEqual(quotaJsonRows.map((row) => row.profile), ["copied", "personal", "work"]);
assert.deepEqual(quotaJsonRows[0], {
  profile: "copied",
  fiveHourRemainingPercent: 75,
  weekRemainingPercent: 50,
});

const sw = run(["sw"]);
assert.equal(sw.status, 0, sw.stderr);
assert.match(sw.stdout, /Best profile: copied \(5h\s+75%, week\s+50%\)/);
assert.match(sw.stdout, /Switched Codex auth to profile: copied/);

const refreshState = path.join(root, "refresh-state.json");
const depletedSw = run(["sw"], {
  MOCK_CODEX_MODE: "depleted",
  MOCK_CODEX_STATE: refreshState,
});
assert.equal(depletedSw.status, 0, depletedSw.stderr);
assert.match(depletedSw.stdout, /All profiles are out of 5h quota\. Refreshing quota/);
assert.match(depletedSw.stdout, /Refreshed quota for copied \(reset\)/);
assert.match(depletedSw.stdout, /Best profile: copied \(5h\s+60%, week\s+50%\)/);
assert.match(depletedSw.stdout, /Switched Codex auth to profile: copied/);

const exhaustedSw = run(["sw"], {
  MOCK_CODEX_MODE: "exhausted",
});
assert.notEqual(exhaustedSw.status, 0);
assert.match(exhaustedSw.stdout, /All profiles are out of 5h quota\. Refreshing quota/);
assert.match(exhaustedSw.stdout, /copied: No reset credits available/);
assert.match(exhaustedSw.stderr, /All profiles are still out of 5h quota after refresh/);

console.log("smoke test passed");
