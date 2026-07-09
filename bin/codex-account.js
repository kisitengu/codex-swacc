#!/usr/bin/env node

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI_NAME = "codex-acc";

function usage() {
  console.log(`Usage:
  ${CLI_NAME} list
  ${CLI_NAME} current
  ${CLI_NAME} use <profile>
  ${CLI_NAME} save <profile>
  ${CLI_NAME} quota [--json]
  ${CLI_NAME} sw

Profiles:
  Stored in: ${profilesDir()}
  Example profile name: work -> ${path.join(profilesDir(), "work.json")}

Environment:
  CODEX_HOME               Override Codex config directory. Default: ~/.codex
  CODEX_ACCOUNT_PROFILES   Override profiles directory.
  CODEX_ACCOUNT_CODEX_BIN  Override codex executable. Default: codex
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
  writePrivateFile(path.join(tempHome, "auth.json"), authContents);
  return tempHome;
}

function callCodexAppServer(codexHomeForCall, requests, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ["app-server", "--stdio"], {
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

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      if (error) {
        reject(error);
      } else {
        resolve(results);
      }
    };

    const timer = setTimeout(() => {
      const waiting = [...pending.values()].join(", ");
      finish(new Error(`Timed out waiting for Codex app-server response: ${waiting}`));
    }, timeoutMs);

    child.on("error", (error) => {
      finish(new Error(`Failed to start ${codexBin()}: ${error.message}`));
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
          finish();
        }
      }
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish(new Error(`Codex app-server exited before responding (${signal || code})${detail}`));
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: CLI_NAME,
            title: "Codex Account",
            version: "1.0.0",
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
    { id: 3, method: "account/usage/read" },
  ]);

  const rateLimits = responses.get(2);
  const usage = responses.get(3);
  if (rateLimits?.error) {
    throw new Error(`account/rateLimits/read failed: ${formatAppServerError(rateLimits.error)}`);
  }
  if (usage?.error) {
    throw new Error(`account/usage/read failed: ${formatAppServerError(usage.error)}`);
  }

  return { rateLimits, usage };
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

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "unknown";
  }
  return `${Math.max(0, Math.round(100 - value))}% remaining (${Math.round(value)}% used)`;
}

function formatResetTime(epochSeconds) {
  if (!epochSeconds) {
    return "unknown reset";
  }

  const resetDate = new Date(epochSeconds * 1000);
  const diffMs = resetDate.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60000);
  const hours = Math.round(absMs / 3600000);
  const days = Math.round(absMs / 86400000);
  let relative;
  if (minutes < 90) {
    relative = `${minutes}m`;
  } else if (hours < 48) {
    relative = `${hours}h`;
  } else {
    relative = `${days}d`;
  }

  return `${resetDate.toLocaleString()} (${diffMs >= 0 ? "in" : ""} ${relative}${diffMs < 0 ? " ago" : ""})`;
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }
  return Number(value).toLocaleString();
}

function remainingPercent(window) {
  if (!window || typeof window.usedPercent !== "number" || Number.isNaN(window.usedPercent)) {
    return null;
  }
  return Math.max(0, Math.round(100 - window.usedPercent));
}

function quotaPrimaryRemaining(quota) {
  return remainingPercent(quota.rateLimits?.rateLimits?.primary);
}

function quotaScore(quota) {
  const snapshot = quota.rateLimits?.rateLimits;
  const primaryRemaining = quotaPrimaryRemaining(quota) ?? -1;
  const secondaryRemaining = snapshot?.secondary ? 100 - snapshot.secondary.usedPercent : -1;
  return primaryRemaining * 1000 + secondaryRemaining;
}

function printQuota(label, quota) {
  const snapshot = quota.rateLimits?.rateLimits;
  const resetCredits = quota.rateLimits?.rateLimitResetCredits;
  const summary = quota.usage?.summary;
  const daily = quota.usage?.dailyUsageBuckets || [];
  const latestDay = daily[daily.length - 1];

  console.log(`Profile: ${label}`);
  if (!snapshot) {
    console.log("Rate limits: unavailable");
    return;
  }

  console.log(`Plan: ${snapshot.planType || "unknown"}`);
  console.log(`Limit: ${snapshot.limitName || snapshot.limitId || "unknown"}`);
  if (snapshot.primary) {
    console.log(`5h window: ${formatPercent(snapshot.primary.usedPercent)}`);
    console.log(`5h reset: ${formatResetTime(snapshot.primary.resetsAt)}`);
  }
  if (snapshot.secondary) {
    console.log(`Weekly window: ${formatPercent(snapshot.secondary.usedPercent)}`);
    console.log(`Weekly reset: ${formatResetTime(snapshot.secondary.resetsAt)}`);
  }
  if (snapshot.credits) {
    const creditState = snapshot.credits.unlimited
      ? "unlimited"
      : `${snapshot.credits.balance ?? "0"} balance`;
    console.log(`Credits: ${snapshot.credits.hasCredits ? "available" : "none"} (${creditState})`);
  }
  if (resetCredits) {
    console.log(`Reset credits: ${resetCredits.availableCount}`);
  }
  if (snapshot.rateLimitReachedType) {
    console.log(`Limit reached: ${snapshot.rateLimitReachedType}`);
  }
  if (summary) {
    console.log(`Lifetime tokens: ${formatNumber(summary.lifetimeTokens)}`);
    console.log(`Peak daily tokens: ${formatNumber(summary.peakDailyTokens)}`);
  }
  if (latestDay) {
    console.log(`Latest daily usage: ${latestDay.startDate} - ${formatNumber(latestDay.tokens)} tokens`);
  }
}

function printQuotaSummary(rows) {
  const successful = rows.filter((row) => row.quota);
  const best = selectBestQuotaRow(successful);

  for (const row of rows) {
    if (row.error) {
      console.log(`${row.profile}: error - ${row.error.message}`);
      continue;
    }

    const snapshot = row.quota.rateLimits?.rateLimits;
    const primary = remainingPercent(snapshot?.primary);
    const secondary = remainingPercent(snapshot?.secondary);
    const marker = best?.profile === row.profile ? " <- best 5h" : "";
    console.log(
      `${row.profile.padEnd(18)} 5h ${formatBar(primary)} ${formatRemaining(primary)}  week ${formatBar(secondary)} ${formatRemaining(secondary)}${marker}`,
    );
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

function selectBestQuotaRow(rows) {
  const usable = rows.filter((row) => row.quota && quotaPrimaryRemaining(row.quota) !== null);
  if (usable.length === 0) {
    return null;
  }

  return usable.reduce((winner, row) => (quotaScore(row.quota) > quotaScore(winner.quota) ? row : winner));
}

function selectBestAvailableQuotaRow(rows) {
  const usable = rows.filter((row) => {
    const remaining = row.quota ? quotaPrimaryRemaining(row.quota) : null;
    return remaining !== null && remaining > 0;
  });
  if (usable.length === 0) {
    return null;
  }

  return usable.reduce((winner, row) => (quotaScore(row.quota) > quotaScore(winner.quota) ? row : winner));
}

function allUsableQuotasDepleted(rows) {
  const usable = rows.filter((row) => row.quota && quotaPrimaryRemaining(row.quota) !== null);
  return usable.length > 0 && usable.every((row) => quotaPrimaryRemaining(row.quota) <= 0);
}

function toQuotaSummaryJson(row) {
  const snapshot = row.quota?.rateLimits?.rateLimits;
  return {
    profile: row.profile,
    fiveHourRemainingPercent: remainingPercent(snapshot?.primary),
    weekRemainingPercent: remainingPercent(snapshot?.secondary),
    error: row.error?.message,
  };
}

async function readAllProfileQuotas() {
  const profiles = getProfileNames();
  if (profiles === null || profiles.length === 0) {
    fail(`No profiles found in: ${profilesDir()}`);
  }

  const rows = [];
  for (const profile of profiles) {
    let tempHome = null;
    try {
      tempHome = createTempCodexHome(readJsonFileOrThrow(profilePath(profile)));
      rows.push({ profile, quota: await readQuotaForCodexHome(tempHome) });
    } catch (error) {
      rows.push({ profile, error: { message: error.message } });
    } finally {
      if (tempHome) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    }
  }
  return rows;
}

async function refreshDepletedProfileQuotas(rows) {
  const results = [];
  for (const row of rows) {
    if (!row.quota || quotaPrimaryRemaining(row.quota) === null || quotaPrimaryRemaining(row.quota) > 0) {
      continue;
    }

    let tempHome = null;
    try {
      tempHome = createTempCodexHome(readJsonFileOrThrow(profilePath(row.profile)));
      const result = await consumeResetCreditForCodexHome(tempHome, row.quota);
      results.push({ profile: row.profile, ...result });
    } catch (error) {
      results.push({ profile: row.profile, consumed: false, message: error.message });
    } finally {
      if (tempHome) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    }
  }
  return results;
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

  const rows = await readAllProfileQuotas();
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows.map(toQuotaSummaryJson), null, 2));
  } else {
    printQuotaSummary(rows);
  }
}

async function swCommand() {
  let rows = await readAllProfileQuotas();
  let best = selectBestAvailableQuotaRow(rows);
  if (!best && allUsableQuotasDepleted(rows)) {
    console.log("All profiles are out of 5h quota. Refreshing quota...");
    printRefreshResults(await refreshDepletedProfileQuotas(rows));
    rows = await readAllProfileQuotas();
    best = selectBestAvailableQuotaRow(rows);
    if (!best && allUsableQuotasDepleted(rows)) {
      fail("All profiles are still out of 5h quota after refresh. No switch was made.");
    }
  }

  if (!best) {
    const errors = rows
      .filter((row) => row.error)
      .map((row) => `${row.profile}: ${row.error.message}`)
      .join("\n");
    fail(`Could not find a usable profile quota.${errors ? `\n${errors}` : ""}`);
  }

  const snapshot = best.quota.rateLimits.rateLimits;
  console.log(
    `Best profile: ${best.profile} (5h ${formatRemaining(remainingPercent(snapshot.primary))}, week ${formatRemaining(remainingPercent(snapshot.secondary))})`,
  );
  useProfile(best.profile);
}

function useProfile(profileName) {
  const source = profilePath(profileName);
  const contents = readJsonFile(source);
  const backupPath = backupCurrentAuth();
  writePrivateFile(authPath(), contents);

  console.log(`Switched Codex auth to profile: ${path.basename(source, ".json")}`);
  console.log(`Wrote: ${authPath()}`);
  if (backupPath) {
    console.log(`Backup: ${backupPath}`);
  }
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
  writePrivateFile(destination, contents);
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
      useProfile(profileName);
      break;
    case "save":
      saveProfile(profileName);
      break;
    case "quota":
    case "usage":
    case "limits":
      await quotaCommand(args);
      break;
    case "sw":
      await swCommand();
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

main().catch((error) => {
  fail(error.message || String(error));
});
