"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  checkAccounts,
  formatCredentialList,
  parseCredentialList,
  rotatePasswords,
  writePrivateAtomic,
} = require("./password-rotation");
const {
  createFileAccountStore,
  createSqliteAccountStore,
  defaultDatabasePath,
} = require("./account-store");
const {
  acquireAuthProfile,
  archiveAuthProfilesForEmail,
  listAuthProfiles,
  normalizeProfileName,
  profilesForEmail,
} = require("./codex-auth");
const { readQuotaSummaries } = require("./quota");

const MAX_BODY_BYTES = 1_000_000;
const DASHBOARD_COOKIE = "codex_dashboard_session";

function maskSecret(value) {
  if (!value || value === "-") {
    return value === "-" ? "-" : "not set";
  }
  return "••••••••";
}

function accountSummary(record, authProfiles = []) {
  const profiles = Array.isArray(authProfiles) ? authProfiles : [];
  const matchingProfiles = profilesForEmail(record.email, profiles).map((profile) => ({
    name: profile.name,
    fileName: profile.fileName,
    isCurrent: profile.isCurrent,
    valid: profile.valid,
  }));
  return {
    email: record.email,
    hasCredentials: true,
    password: maskSecret(record.password),
    mfa: record.mfaSecret === "-" ? "-" : maskSecret(record.mfaSecret),
    mfaEnabled: record.mfaSecret !== "-",
    status: record.status || "unchecked",
    statusMessage: record.statusMessage || null,
    lastCheckedAt: record.lastCheckedAt || null,
    authProfiles: matchingProfiles,
    authStatus: matchingProfiles.length === 0
      ? "missing"
      : matchingProfiles.length === 1
        ? "available"
        : "multiple",
  };
}

function mergedAccountSummaries(records, authProfiles = []) {
  const profiles = Array.isArray(authProfiles) ? authProfiles : [];
  const summaries = records.map((record) => accountSummary(record, profiles));
  const credentialEmails = new Set(records.map((record) => accountKey(record.email)));
  const authOnlyEmails = new Map();
  for (const profile of profiles) {
    if (!profile.email || credentialEmails.has(accountKey(profile.email))) {
      continue;
    }
    const key = accountKey(profile.email);
    if (!authOnlyEmails.has(key)) {
      authOnlyEmails.set(key, profile.email);
    }
  }
  const authOnly = [...authOnlyEmails.values()]
    .sort((left, right) => left.localeCompare(right))
    .map((email) => {
      const matchingProfiles = profilesForEmail(email, profiles).map((profile) => ({
        name: profile.name,
        fileName: profile.fileName,
        isCurrent: profile.isCurrent,
        valid: profile.valid,
      }));
      return {
        email,
        hasCredentials: false,
        password: "-",
        mfa: "-",
        mfaEnabled: false,
        status: "auth_only",
        statusMessage: "Codex auth exists; password and MFA are not stored in the dashboard.",
        lastCheckedAt: null,
        authProfiles: matchingProfiles,
        authStatus: matchingProfiles.length === 1 ? "available" : "multiple",
      };
    });
  return [...summaries, ...authOnly];
}

function quotaForProfiles(authProfiles, quotaByProfile) {
  if (!(quotaByProfile instanceof Map)) {
    return null;
  }
  const ordered = [...authProfiles].sort(
    (left, right) => Number(right.isCurrent) - Number(left.isCurrent),
  );
  for (const profile of ordered) {
    const quota = quotaByProfile.get(profile.name.toLowerCase());
    if (quota) {
      return quota;
    }
  }
  return null;
}

function attachQuota(summaries, quotaByProfile) {
  return summaries.map((summary) => ({
    ...summary,
    quota: quotaForProfiles(summary.authProfiles, quotaByProfile),
  }));
}

function accountKey(email) {
  return email.trim().toLowerCase();
}

function validateAccountInput(payload, existing = null) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Account payload must be an object.");
  }
  const email = String(payload.email ?? existing?.email ?? "").trim();
  const password = payload.password === undefined
    ? existing?.password
    : String(payload.password);
  const mfaSecret = payload.mfaSecret === undefined
    ? existing?.mfaSecret
    : String(payload.mfaSecret).trim();

  if (!email || !password || !mfaSecret) {
    throw new Error("Email, password, and MFA secret are required. Use '-' for no MFA.");
  }
  const [record] = parseCredentialList(`${email}|${password}|${mfaSecret}\n`);
  return record;
}

function parsePort(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error("Dashboard port must be an integer.");
  }
  const port = Number(value);
  if (port < 0 || port > 65535) {
    throw new Error("Dashboard port must be between 0 and 65535.");
  }
  return port;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendCredentialExport(response, records) {
  const body = formatCredentialList(records);
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="codex-accounts-${timestamp}.txt"`,
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendHtml(response, token) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
    "set-cookie": `${DASHBOARD_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
    "x-content-type-options": "nosniff",
  });
  response.end(DASHBOARD_HTML);
}

function sendError(response, error) {
  const statusCode = /not found/i.test(error.message) ? 404 : 400;
  sendJson(response, statusCode, { error: error.message });
}

function tokenFromRequest(request, url) {
  return request.headers["x-dashboard-token"]
    || request.headers.authorization?.replace(/^Bearer\s+/i, "")
    || url.searchParams.get("token")
    || String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === DASHBOARD_COOKIE)?.slice(1).join("=");
}

function unauthorized(response) {
  sendJson(response, 401, { error: "Dashboard session token is required." });
}

function switchAuthProfile(profileName, { spawnProcess = spawn } = {}) {
  const normalized = normalizeProfileName(profileName);
  const cliPath = path.resolve(__dirname, "..", "bin", "codex-account.js");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawnProcess(process.execPath, [cliPath, "use", normalized], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(
          stderr.trim() || stdout.trim() || `Could not switch Codex auth profile (${code}).`,
        ));
        return;
      }
      resolve({
        profile: normalized,
        restarting: /Restarting Codex App/i.test(stdout),
      });
    });
  });
}

function openExternal(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

function dashboardHtmlState(filePath, storageKind) {
  return {
    fileName: path.basename(filePath),
    storage: storageKind,
  };
}

function recoverInterruptedAccountStatuses(store) {
  const interrupted = store.read().filter(
    (record) => record.status === "checking" || record.status === "rotating",
  );
  const now = new Date().toISOString();
  for (const record of interrupted) {
    const passwordWasSubmitted = record.status === "rotating"
      && /password.*submitted|submitted.*password/i.test(record.statusMessage || "");
    store.updateStatus(record.email, {
      status: passwordWasSubmitted ? "rotation_unverified" : "check_failed",
      statusMessage: passwordWasSubmitted
        ? "Password submission was interrupted before confirmation; run Check to verify login."
        : record.status === "checking"
          ? "Availability check was interrupted; run Check again."
          : "Password rotation was interrupted before submission; retry Rotate.",
      lastCheckedAt: now,
    });
  }
  return interrupted.length;
}

function createDashboardServer({
  filePath,
  dbPath = defaultDatabasePath(),
  port = 0,
  open = true,
  rotate = rotatePasswords,
  check = checkAccounts,
  acquireAuth = acquireAuthProfile,
  archiveAuth = archiveAuthProfilesForEmail,
  getAuthProfiles = listAuthProfiles,
  switchProfile = switchAuthProfile,
  readQuotas = readQuotaSummaries,
  logger = console,
} = {}) {
  const store = filePath
    ? createFileAccountStore(filePath)
    : createSqliteAccountStore(dbPath);
  recoverInterruptedAccountStatuses(store);
  const token = crypto.randomBytes(32).toString("hex");
  const jobs = new Map();
  const quotaByProfile = new Map();
  const quotaState = {
    status: "idle",
    lastUpdatedAt: null,
    error: null,
  };
  let server;

  function recordsForEmail(email, emails) {
    const records = store.read();
    if (email !== undefined && emails !== undefined) {
      throw new Error("Provide either email or emails, not both.");
    }
    if (emails !== undefined) {
      if (!Array.isArray(emails) || emails.length === 0) {
        throw new Error("Select at least one account.");
      }
      const requested = new Set(emails.map((value) => accountKey(String(value))));
      if (requested.has("")) {
        throw new Error("Selected account emails cannot be empty.");
      }
      const selected = records.filter((record) => requested.has(accountKey(record.email)));
      if (selected.length !== requested.size) {
        const found = new Set(selected.map((record) => accountKey(record.email)));
        const missing = [...requested].find((key) => !found.has(key));
        throw new Error(`Account not found: ${missing}`);
      }
      return selected;
    }
    if (!email) {
      return records;
    }
    const selected = records.find(
      (record) => accountKey(record.email) === accountKey(email),
    );
    if (!selected) {
      throw new Error(`Account not found: ${email}`);
    }
    return [selected];
  }

  function setAccountStatus({
    email,
    status,
    message = null,
  }) {
    const current = store.read().find(
      (record) => accountKey(record.email) === accountKey(email),
    );
    if (!current) {
      return;
    }
    const terminal = !new Set(["checking", "rotating"]).has(status);
    store.updateStatus(current.email, {
      status,
      statusMessage: message,
      lastCheckedAt: terminal ? new Date().toISOString() : current.lastCheckedAt,
    });
  }

  function persistSubmittedPassword({ email, password }) {
    const current = store.read().find(
      (record) => accountKey(record.email) === accountKey(email),
    );
    if (!current) {
      throw new Error(`Account not found: ${email}`);
    }
    store.update(current.email, {
      ...current,
      password,
    }, { resetStatus: false });
  }

  function runningJob() {
    return [...jobs.values()].find((job) => job.status === "running");
  }

  function createJob(type, records) {
    const job = {
      id: crypto.randomUUID(),
      type,
      status: "running",
      email: records.length === 1 ? records[0].email : null,
      accountCount: records.length,
      file: path.basename(store.filePath),
      startedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    return job;
  }

  async function refreshQuotaCache() {
    Object.assign(quotaState, {
      status: "running",
      error: null,
    });
    try {
      const rows = await readQuotas();
      quotaByProfile.clear();
      for (const row of rows) {
        quotaByProfile.set(row.profile.toLowerCase(), row);
      }
      const failed = rows.filter((row) => row.error).length;
      const finishedAt = new Date().toISOString();
      Object.assign(quotaState, {
        status: failed > 0 ? "completed-with-errors" : "success",
        lastUpdatedAt: finishedAt,
        error: null,
      });
      return { rows, failed, finishedAt };
    } catch (error) {
      Object.assign(quotaState, {
        status: "failed",
        error: error.message,
        lastUpdatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/accounts" && request.method === "GET") {
      const records = store.read();
      const authProfiles = getAuthProfiles();
      sendJson(response, 200, {
        file: dashboardHtmlState(store.filePath, store.kind),
        accounts: attachQuota(
          mergedAccountSummaries(records, authProfiles),
          quotaByProfile,
        ),
        authProfiles: authProfiles.map((profile) => ({
          name: profile.name,
          fileName: profile.fileName,
          email: profile.email,
          isCurrent: profile.isCurrent,
          valid: profile.valid,
          error: profile.error ? "Invalid auth profile" : null,
        })),
        quota: { ...quotaState },
      });
      return;
    }

    if (url.pathname === "/api/accounts/export" && request.method === "GET") {
      sendCredentialExport(response, store.read());
      return;
    }

    if (url.pathname === "/api/accounts" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const account = validateAccountInput(payload);
      const records = store.read();
      if (records.some((record) => accountKey(record.email) === accountKey(account.email))) {
        throw new Error(`Account already exists: ${account.email}`);
      }
      store.add(account);
      sendJson(response, 201, { account: accountSummary(account) });
      return;
    }

    if (url.pathname === "/api/accounts/import" && request.method === "POST") {
      const payload = await readJsonBody(request);
      if (typeof payload.accounts !== "string") {
        throw new Error("Bulk import requires an accounts string.");
      }
      const imported = parseCredentialList(payload.accounts);
      const records = store.read();
      const existingEmails = new Set(records.map((record) => accountKey(record.email)));
      const duplicate = imported.find((record) => existingEmails.has(accountKey(record.email)));
      if (duplicate) {
        throw new Error(`Account already exists: ${duplicate.email}`);
      }
      store.replace([...records, ...imported]);
      sendJson(response, 201, {
        imported: imported.length,
        accounts: imported.map(accountSummary),
      });
      return;
    }

    const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const email = decodeURIComponent(accountMatch[1]);
      const records = store.read();
      const index = records.findIndex((record) => accountKey(record.email) === accountKey(email));

      if (request.method === "DELETE") {
        const matchingProfiles = profilesForEmail(email, getAuthProfiles());
        if (index < 0 && matchingProfiles.length === 0) {
          throw new Error(`Account not found: ${email}`);
        }
        if (index >= 0) {
          store.remove(records[index].email);
        }
        const archivedProfiles = archiveAuth(email);
        sendJson(response, 200, {
          deleted: email,
          credentialsDeleted: index >= 0,
          authProfilesArchived: archivedProfiles.length,
        });
        return;
      }

      if (index < 0) {
        throw new Error(`Stored credentials not found: ${email}`);
      }
      const payload = await readJsonBody(request);
      if (
        payload.email !== undefined
        && accountKey(String(payload.email)) !== accountKey(records[index].email)
      ) {
        throw new Error("Account email cannot be changed from the dashboard.");
      }
      const updated = validateAccountInput(payload, records[index]);
      store.update(records[index].email, updated);
      sendJson(response, 200, { account: accountSummary(updated) });
      return;
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      sendJson(response, 200, { jobs: [...jobs.values()] });
      return;
    }

    if (url.pathname === "/api/quota/refresh" && request.method === "POST") {
      if (runningJob()) {
        throw new Error("Another account operation is already running.");
      }
      const job = createJob("quota", []);
      sendJson(response, 202, { job });
      refreshQuotaCache().then(({ rows, failed, finishedAt }) => {
        Object.assign(job, {
          status: quotaState.status,
          result: {
            success: rows.length - failed,
            failed,
          },
          finishedAt,
        });
      }).catch((error) => {
        Object.assign(job, {
          status: "failed",
          error: error.message,
          finishedAt: quotaState.lastUpdatedAt,
        });
      });
      return;
    }

    if (url.pathname === "/api/auth/acquire" && request.method === "POST") {
      if (runningJob()) {
        throw new Error("Another account operation is already running.");
      }
      const payload = await readJsonBody(request);
      const records = recordsForEmail(payload.email, payload.emails);
      if (records.length === 0) {
        throw new Error("Add at least one account before getting Codex auth.");
      }
      if (payload.profileName && records.length !== 1) {
        throw new Error("A custom profile name can only be used with one account.");
      }
      const job = createJob("auth", records);
      sendJson(response, 202, { job });
      (async () => {
        const results = [];
        for (const record of records) {
          try {
            const profile = await acquireAuth(record, {
              profileName: payload.profileName,
              onStep: (message) => logger.log(`[dashboard] ${message}`),
            });
            results.push({
              email: record.email,
              status: "success",
              profile: profile.fileName,
            });
          } catch (error) {
            logger.error(`[dashboard] Get auth failed for ${record.email}: ${error.message}`);
            results.push({
              email: record.email,
              status: "failed",
              error: error.message,
            });
          }
        }
        const success = results.filter((result) => result.status === "success").length;
        const failed = results.length - success;
        let quotaRefreshError = null;
        try {
          await refreshQuotaCache();
        } catch (error) {
          quotaRefreshError = error.message;
        }
        Object.assign(job, {
          status: failed > 0 ? "completed-with-errors" : "success",
          result: {
            success,
            failed,
            accounts: results,
            quotaRefreshError,
          },
          finishedAt: new Date().toISOString(),
        });
      })().catch((error) => {
        Object.assign(job, {
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      });
      return;
    }

    if (url.pathname === "/api/auth/use" && request.method === "POST") {
      if (runningJob()) {
        throw new Error("Another account operation is already running.");
      }
      const payload = await readJsonBody(request);
      const profileName = normalizeProfileName(payload.profileName);
      const profile = getAuthProfiles().find(
        (candidate) => candidate.name.toLowerCase() === profileName.toLowerCase(),
      );
      if (!profile) {
        throw new Error(`Codex auth profile not found: ${profileName}`);
      }
      if (!profile.valid) {
        throw new Error(`Codex auth profile is incomplete: ${profile.fileName}`);
      }
      const result = await switchProfile(profile.name);
      sendJson(response, 200, result);
      return;
    }

    if (url.pathname === "/api/check" && request.method === "POST") {
      if (runningJob()) {
        throw new Error("Another account operation is already running.");
      }
      const payload = await readJsonBody(request);
      const records = recordsForEmail(payload.email, payload.emails);
      if (records.length === 0) {
        throw new Error("Add at least one account before checking availability.");
      }
      const job = createJob("check", records);
      for (const record of records) {
        setAccountStatus({
          email: record.email,
          status: "checking",
          message: "Waiting for login check.",
        });
      }
      sendJson(response, 202, { job });

      check(records, {}, {
        log: (message) => logger.log(`[dashboard] ${message}`),
        error: (message) => logger.error(`[dashboard] ${message}`),
        onAccountStatus: setAccountStatus,
      }).then((result) => {
        for (const accountResult of result.results || []) {
          setAccountStatus({
            email: accountResult.email,
            status: accountResult.status,
            message: accountResult.message,
          });
        }
        Object.assign(job, {
          status: result.failed > 0 ? "completed-with-errors" : "success",
          result: {
            success: result.success,
            failed: result.failed,
          },
          finishedAt: new Date().toISOString(),
        });
      }).catch((error) => {
        for (const record of records) {
          setAccountStatus({
            email: record.email,
            status: "check_failed",
            message: error.message,
          });
        }
        Object.assign(job, {
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      });
      return;
    }

    if (url.pathname === "/api/rotate" && request.method === "POST") {
      if (runningJob()) {
        throw new Error("Another account operation is already running.");
      }
      const payload = await readJsonBody(request);
      const records = recordsForEmail(payload.email, payload.emails);
      if (records.length === 0) {
        throw new Error("Add at least one account before starting rotation.");
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dashboard-rotation-"));
      const sourcePath = path.join(tempDir, "accounts.txt");
      const outputPath = path.join(tempDir, "accounts.rotated.txt");
      writePrivateAtomic(sourcePath, formatCredentialList(records));
      if (outputPath === sourcePath) {
        throw new Error("Rotation output must be different from the dashboard account file.");
      }
      const job = createJob("rotation", records);
      job.output = path.basename(store.filePath);
      for (const record of records) {
        setAccountStatus({
          email: record.email,
          status: "rotating",
          message: "Waiting for password rotation.",
        });
      }
      sendJson(response, 202, { job });

      const rotationArgs = [
        sourcePath,
        "--output",
        outputPath,
        "--yes",
        "--unattended",
        "--continue-on-error",
      ];
      if (payload.skipVerify === true) {
        rotationArgs.push("--skip-verify");
      }
      rotate(rotationArgs, {
        log: (message) => logger.log(`[dashboard] ${message}`),
        error: (message) => logger.error(`[dashboard] ${message}`),
        onAccountStatus: setAccountStatus,
        onPasswordSubmitted: persistSubmittedPassword,
      }).then((result) => {
        if (fs.existsSync(outputPath)) {
          const rotatedRecords = parseCredentialList(fs.readFileSync(outputPath, "utf8"));
          for (const rotated of rotatedRecords) {
            store.update(rotated.email, rotated, { resetStatus: false });
          }
        }
        if (result.failed === 0) {
          for (const record of records) {
            setAccountStatus({
              email: record.email,
              status: "active",
              message: "Password rotated and login verified.",
            });
          }
        }
        Object.assign(job, {
          status: result.failed > 0 ? "completed-with-errors" : "success",
          result: {
            success: result.success,
            failed: result.failed,
            output: store.filePath,
          },
          finishedAt: new Date().toISOString(),
        });
      }).catch((error) => {
        for (const record of records) {
          const current = store.read().find(
            (candidate) => accountKey(candidate.email) === accountKey(record.email),
          );
          if (current?.status === "rotating") {
            setAccountStatus({
              email: record.email,
              status: "check_failed",
              message: error.message,
            });
          }
        }
        Object.assign(job, {
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      }).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
      return;
    }

    sendJson(response, 404, { error: "Dashboard API route not found." });
  }

  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (tokenFromRequest(request, url) !== token) {
      unauthorized(response);
      return;
    }

    if (url.pathname === "/" && request.method === "GET") {
      sendHtml(response, token);
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    try {
      await handleApi(request, response, url);
    } catch (error) {
      sendError(response, error);
    }
  });

  return {
    token,
    filePath: store.filePath,
    dbPath: store.kind === "sqlite" ? store.filePath : null,
    storageKind: store.kind,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(parsePort(port), "127.0.0.1", () => {
          const address = server.address();
          const url = `http://127.0.0.1:${address.port}/?token=${token}`;
          if (open) {
            openExternal(url);
          }
          logger.log(`Dashboard: ${url}`);
          resolve({ url, port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        const finish = () => {
          store.close();
          resolve();
        };
        if (!server.listening) {
          finish();
          return;
        }
        server.close(finish);
      });
    },
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex account dashboard</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111827; color: #e5e7eb; }
    main { max-width: 1480px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    p, .muted { color: #9ca3af; }
    .card { background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 18px; margin-top: 18px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { border: 0; border-radius: 8px; padding: 9px 13px; cursor: pointer; color: white; background: #2563eb; font-weight: 600; }
    button.secondary { background: #4b5563; }
    button.danger { background: #b91c1c; }
    button:disabled { opacity: .5; cursor: wait; }
    input, textarea, select { width: 100%; box-sizing: border-box; background: #111827; color: #f9fafb; border: 1px solid #4b5563; border-radius: 7px; padding: 9px 10px; }
    input[type="checkbox"] { width: 16px; height: 16px; padding: 0; accent-color: #2563eb; }
    textarea { resize: vertical; min-height: 130px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    label { display: grid; gap: 6px; color: #d1d5db; font-size: 13px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
    .section-heading { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin: 28px 0 12px; }
    .section-heading h2 { margin: 0; }
    .view-switch { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid #4b5563; border-radius: 10px; background: #111827; }
    .view-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .account-options { display: flex; gap: 8px; align-items: center; }
    .compact-control { display: flex; grid-template-columns: auto 1fr; gap: 6px; align-items: center; white-space: nowrap; }
    .compact-control select { width: auto; min-width: 112px; padding: 6px 28px 6px 8px; font-size: 12px; }
    .sort-header { display: inline-flex; gap: 5px; align-items: center; padding: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; }
    .sort-header:hover, .sort-header:focus-visible { color: #dbeafe; }
    .sort-indicator { min-width: 10px; color: #60a5fa; }
    .card-select-all { display: flex; grid-template-columns: auto 1fr; gap: 7px; align-items: center; color: #d1d5db; white-space: nowrap; }
    .card-select-all[hidden] { display: none; }
    .view-button { padding: 6px 10px; border-radius: 6px; background: transparent; color: #9ca3af; font-size: 12px; }
    .view-button[aria-pressed="true"] { background: #2563eb; color: #fff; }
    .table-wrap { width: 100%; overflow-x: auto; scrollbar-gutter: stable; }
    .account-view table { width: 100%; min-width: 1050px; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #374151; text-align: left; vertical-align: middle; }
    th { color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    td code { color: #bfdbfe; font-size: 13px; }
    .actions { min-width: 76px; white-space: nowrap; }
    .action-buttons { display: flex; gap: 7px; flex-wrap: nowrap; align-items: center; }
    .icon-button { display: inline-grid; place-items: center; flex: 0 0 34px; width: 34px; height: 34px; padding: 0; }
    .icon-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .email-cell { overflow-wrap: anywhere; }
    .auth-cell { min-width: 0; }
    .auth-profiles { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; max-width: 100%; }
    .auth-profile { display: inline-flex; gap: 5px; align-items: center; max-width: 100%; min-width: 0; border-radius: 6px; padding: 4px 7px; box-sizing: border-box; background: #374151; color: #dbeafe; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .auth-profile-label { min-width: 0; overflow-wrap: anywhere; }
    .auth-profile.current { background: #064e3b; color: #a7f3d0; }
    .profile-switch { flex: 0 0 auto; padding: 4px 7px; border-radius: 5px; font-size: 11px; }
    .auth-missing { color: #fbbf24; font-size: 12px; }
    .quota-value { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #dbeafe; font-size: 12px; font-weight: 700; }
    .quota-track { height: 5px; margin-top: 6px; overflow: hidden; border-radius: 999px; background: #374151; }
    .quota-fill { height: 100%; border-radius: inherit; background: #3b82f6; }
    .quota-fill.low { background: #f59e0b; }
    .quota-fill.empty { background: #ef4444; }
    .quota-detail { display: block; margin-top: 5px; overflow: hidden; color: #9ca3af; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
    .quota-error { color: #fca5a5; font-size: 12px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: #374151; color: #e5e7eb; }
    .badge.active { background: #064e3b; color: #a7f3d0; }
    .badge.unchecked { background: #374151; color: #d1d5db; }
    .badge.auth_only { background: #312e81; color: #c7d2fe; }
    .badge.checking, .badge.rotating { background: #1e3a8a; color: #bfdbfe; }
    .badge.invalid_credentials, .badge.invalid_mfa, .badge.banned { background: #7f1d1d; color: #fecaca; }
    .badge.verification_required, .badge.rotation_unverified { background: #78350f; color: #fde68a; }
    .badge.auth_error, .badge.check_failed { background: #581c87; color: #e9d5ff; }
    .empty-state { margin: 16px 0 4px; color: #9ca3af; text-align: center; }
    #status { min-height: 22px; margin-top: 12px; color: #93c5fd; white-space: pre-wrap; }
    .warning { color: #fbbf24; }
    .account-view.cards-view .table-wrap { overflow: visible; }
    .account-view.cards-view table { min-width: 0; border-collapse: separate; table-layout: auto; }
    .account-view.cards-view colgroup, .account-view.cards-view thead { display: none; }
    .account-view.cards-view tbody { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 16px; }
    .account-view.cards-view tr { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 14px; align-content: start; padding: 16px; border: 1px solid #374151; border-radius: 12px; background: #111827; box-shadow: 0 8px 22px rgba(0, 0, 0, .16); }
    .account-view.cards-view td { display: block; min-width: 0; padding: 8px 0; border-bottom: 1px solid #273449; overflow-wrap: anywhere; }
    .account-view.cards-view td::before { content: attr(data-label); display: block; margin-bottom: 6px; color: #6b7280; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .account-view.cards-view td:first-child { position: absolute; top: 16px; right: 16px; z-index: 1; padding: 0; border: 0; }
    .account-view.cards-view td:first-child::before { display: none; }
    .account-view.cards-view td:nth-child(2), .account-view.cards-view td:nth-child(3), .account-view.cards-view td:nth-child(4) { grid-column: 1 / -1; }
    .account-view.cards-view td:nth-child(2) { padding: 0 42px 10px 0; color: #f9fafb; font-size: 16px; font-weight: 750; }
    .account-view.cards-view td:nth-child(5), .account-view.cards-view td:nth-child(6) { padding: 10px 0 0; border: 0; }
    .account-view.cards-view td:nth-child(6) { grid-column: 2; grid-row: 4; align-self: end; }
    .account-view.cards-view .auth-profile { width: auto; }
    .account-view.cards-view .quota-track { min-width: 0; }
    .account-view.cards-view .action-buttons { justify-content: flex-end; }
    @media (max-width: 720px) { main { padding: 22px 12px 48px; } .card { padding: 14px; } .section-heading { align-items: flex-start; } .view-controls { width: 100%; justify-content: space-between; } }
  </style>
</head>
<body>
<main>
  <h1>Codex account dashboard</h1>
  <p>Local-only manager for <code id="file-name"></code>. Stored credentials stay hidden in this view.</p>
  <div class="card">
    <div class="toolbar">
      <button id="refresh">Refresh</button>
      <button id="check-all" disabled>Check credentials (0)</button>
      <button id="rotate-all" disabled>Rotate (0)</button>
      <button id="auth-all" disabled>Get Auth (0)</button>
      <button id="quota-refresh" class="secondary">Refresh quota</button>
      <button id="export-all" class="secondary">Export accounts</button>
      <span class="muted" id="account-count"></span>
      <span class="muted" id="quota-meta"></span>
    </div>
    <div id="status"></div>
  </div>
  <div class="card">
    <div class="section-heading">
      <h2>Accounts</h2>
      <div class="view-controls">
        <div class="account-options">
          <label class="compact-control">Quota<select id="quota-filter" aria-label="Filter by quota"><option value="all">All</option><option value="available">Has quota (&gt;0%)</option><option value="exhausted">No quota (0%)</option></select></label>
        </div>
        <label id="card-select-all-control" class="card-select-all" hidden><input id="select-all-cards" type="checkbox" aria-label="Select all accounts in cards"> Select all</label>
        <div class="view-switch" role="group" aria-label="Account view">
          <button id="view-list" class="view-button" type="button" aria-pressed="true">List</button>
          <button id="view-cards" class="view-button" type="button" aria-pressed="false">Cards</button>
        </div>
      </div>
    </div>
    <div id="account-view" class="account-view list-view">
      <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width: 38px">
            <col style="width: 250px">
            <col style="width: 240px">
            <col style="width: 240px">
            <col style="width: 190px">
            <col style="width: 93px">
          </colgroup>
          <thead><tr><th><input id="select-all" type="checkbox" aria-label="Select all accounts"></th><th>Email</th><th>Codex auth</th><th><button id="quota-sort" class="sort-header" type="button" aria-label="Sort by quota: default" title="Sort: Default" data-sort="default">Quota <span id="quota-sort-indicator" class="sort-indicator">↕</span></button></th><th>Credential check</th><th>Actions</th></tr></thead>
          <tbody id="accounts"></tbody>
        </table>
      </div>
      <p id="account-empty" class="empty-state" hidden>No accounts match this quota filter.</p>
    </div>
  </div>
  <div class="card">
    <h2>Add account</h2>
    <form id="add-form" class="form-grid">
      <label>Email<input name="email" type="email" required autocomplete="off"></label>
      <label>Password<input name="password" type="password" required autocomplete="new-password"></label>
      <label>MFA secret<input name="mfaSecret" placeholder="Base32 secret or -"></label>
      <div class="toolbar"><button type="submit">Add account</button></div>
    </form>
  </div>
  <div class="card">
    <h2>Import multiple accounts</h2>
    <p class="muted">Enter one account per line: <code>email|password|MFA-secret</code>. Use <code>-</code> when MFA is not enabled.</p>
    <form id="import-form">
      <label>Accounts<textarea name="accounts" required rows="7" spellcheck="false" placeholder="first@example.com|password|BASE32-SECRET&#10;second@example.com|password|-"></textarea></label>
      <div class="toolbar" style="margin-top: 12px"><button type="submit">Import accounts</button></div>
    </form>
  </div>
  <div class="card" id="edit-card" hidden>
    <h2 id="edit-title">Edit account</h2>
    <p class="muted" id="edit-help">Leave password or MFA blank to keep the existing value. Use <code>-</code> to remove MFA.</p>
    <form id="edit-form" class="form-grid">
      <label>Email<input name="email" type="email" readonly></label>
      <label>New password<input name="password" type="password" autocomplete="new-password"></label>
      <label>New MFA secret<input name="mfaSecret" placeholder="Base32 secret or -"></label>
      <div class="toolbar"><button type="submit">Save changes</button><button type="button" class="secondary" id="cancel-edit">Cancel</button></div>
    </form>
  </div>
</main>
<script>
(() => {
  const queryToken = new URLSearchParams(location.search).get("token");
  if (queryToken) {
    history.replaceState({}, "", "/");
  }
  const VIEW_MODE_KEY = "codex-account-dashboard-view";
  const storedViewMode = (() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "cards" ? "cards" : "list";
    } catch {
      return "list";
    }
  })();
  const headers = { "content-type": "application/json" };
  const state = {
    accounts: [],
    selectedEmail: null,
    selectedHasCredentials: true,
    selectedEmails: new Set(),
    activeJobId: null,
    viewMode: storedViewMode,
    quotaFilter: "all",
    quotaSort: "default",
    quota: { status: "idle", lastUpdatedAt: null, error: null },
  };
  let quotaAutoStarted = false;
  const $ = (selector) => document.querySelector(selector);
  const setViewMode = (mode, { persist = true } = {}) => {
    const nextMode = mode === "cards" ? "cards" : "list";
    state.viewMode = nextMode;
    const view = $("#account-view");
    view.classList.toggle("list-view", nextMode === "list");
    view.classList.toggle("cards-view", nextMode === "cards");
    $("#view-list").setAttribute("aria-pressed", String(nextMode === "list"));
    $("#view-cards").setAttribute("aria-pressed", String(nextMode === "cards"));
    $("#card-select-all-control").hidden = nextMode !== "cards";
    if (persist) {
      try {
        localStorage.setItem(VIEW_MODE_KEY, nextMode);
      } catch {
        // The view still changes when browser storage is unavailable.
      }
    }
  };
  const statusLabels = {
    unchecked: "Not checked",
    auth_only: "Auth only",
    checking: "Checking",
    active: "Credentials valid",
    invalid_credentials: "Invalid credentials",
    invalid_mfa: "Invalid MFA",
    banned: "Banned / disabled",
    verification_required: "Verification required",
    auth_error: "Auth service error",
    check_failed: "Check failed",
    rotating: "Rotating password",
    rotation_unverified: "Password changed, unverified",
  };
  const status = (message, warning = false) => {
    $("#status").textContent = message;
    $("#status").className = warning ? "warning" : "";
  };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Request failed");
    return body;
  };
  const quotaRemaining = (quotaSummary) => {
    if (!quotaSummary || quotaSummary.error) return null;
    if (typeof quotaSummary.weekRemainingPercent === "number") {
      return quotaSummary.weekRemainingPercent;
    }
    const fallback = quotaSummary.otherWindows?.[0]?.remainingPercent;
    return typeof fallback === "number" ? fallback : null;
  };
  const visibleAccounts = () => {
    const rows = state.accounts
      .map((account, index) => ({ account, index, remaining: quotaRemaining(account.quota) }))
      .filter(({ remaining }) => (
        state.quotaFilter === "all"
        || (state.quotaFilter === "available" && remaining !== null && remaining > 0)
        || (state.quotaFilter === "exhausted" && remaining === 0)
      ));
    if (state.quotaSort === "default") {
      return rows.map(({ account }) => account);
    }
    const direction = state.quotaSort === "asc" ? 1 : -1;
    return rows
      .sort((left, right) => {
        if (left.remaining === null && right.remaining === null) return left.index - right.index;
        if (left.remaining === null) return 1;
        if (right.remaining === null) return -1;
        return ((left.remaining - right.remaining) * direction) || (left.index - right.index);
      })
      .map(({ account }) => account);
  };
  const updateSelectionControls = () => {
    const count = state.selectedEmails.size;
    const shownAccounts = visibleAccounts();
    const selectableCount = shownAccounts.filter((account) => account.hasCredentials).length;
    $("#account-count").textContent = shownAccounts.length + " of " + state.accounts.length + " shown · "
      + selectableCount + " with credentials · " + count + " selected";
    $("#check-all").textContent = "Check credentials (" + count + ")";
    $("#rotate-all").textContent = "Rotate (" + count + ")";
    $("#auth-all").textContent = "Get Auth (" + count + ")";
    $("#check-all").disabled = Boolean(state.activeJobId) || count === 0;
    $("#rotate-all").disabled = Boolean(state.activeJobId) || count === 0;
    $("#auth-all").disabled = Boolean(state.activeJobId) || count === 0;
    $("#quota-refresh").disabled = Boolean(state.activeJobId)
      || state.quota.status === "running";
    for (const selectAll of [$("#select-all"), $("#select-all-cards")]) {
      selectAll.checked = selectableCount > 0 && count === selectableCount;
      selectAll.indeterminate = count > 0 && count < selectableCount;
      selectAll.disabled = Boolean(state.activeJobId) || selectableCount === 0;
    }
  };
  const formatDuration = (durationMins) => {
    if (durationMins % 1440 === 0) return (durationMins / 1440) + "d";
    if (durationMins % 60 === 0) return (durationMins / 60) + "h";
    return durationMins + "m";
  };
  const createQuotaCell = (quotaSummary) => {
    const quotaCell = document.createElement("td");
    if (!quotaSummary) {
      quotaCell.textContent = "—";
      return quotaCell;
    }
    if (quotaSummary.error) {
      const error = document.createElement("span");
      error.className = "quota-error";
      error.textContent = /token_revoked|invalidated oauth token|401 Unauthorized/i.test(
        quotaSummary.error,
      ) ? "Auth revoked" : "Quota error";
      error.title = quotaSummary.error;
      quotaCell.append(error);
      return quotaCell;
    }
    let label = "week";
    let remaining = quotaSummary.weekRemainingPercent;
    let resetsAt = quotaSummary.weekResetsAt;
    if (remaining === null && quotaSummary.otherWindows.length > 0) {
      label = formatDuration(quotaSummary.otherWindows[0].durationMins);
      remaining = quotaSummary.otherWindows[0].remainingPercent;
      resetsAt = quotaSummary.otherWindows[0].resetsAt;
    }
    if (remaining === null) {
      quotaCell.textContent = "Unknown";
    } else {
      const value = document.createElement("div");
      value.className = "quota-value";
      value.innerHTML = "<span>" + label + "</span><span>" + remaining + "%</span>";
      const track = document.createElement("div");
      track.className = "quota-track";
      const fill = document.createElement("div");
      fill.className = "quota-fill"
        + (remaining <= 0 ? " empty" : remaining <= 20 ? " low" : "");
      fill.style.width = remaining + "%";
      track.append(fill);
      quotaCell.append(value, track);
    }
    const details = [];
    if (resetsAt) {
      const resetAt = new Date(resetsAt);
      if (!Number.isNaN(resetAt.getTime())) {
        details.push("Reset " + resetAt.toLocaleString([], {
          dateStyle: "short",
          timeStyle: "short",
        }));
      }
    }
    if (quotaSummary.resetCreditsAvailable !== null) {
      details.push(quotaSummary.resetCreditsAvailable + " credit"
        + (quotaSummary.resetCreditsAvailable === 1 ? "" : "s"));
    }
    if (details.length > 0) {
      const detail = document.createElement("span");
      detail.className = "quota-detail";
      detail.textContent = details.join(" · ");
      quotaCell.append(detail);
    }
    quotaCell.title = "Quota for " + quotaSummary.profile;
    if (quotaSummary.resetCreditsNextExpiry) {
      quotaCell.title += " · Reset credits expire " + new Date(
        quotaSummary.resetCreditsNextExpiry,
      ).toLocaleString();
    }
    return quotaCell;
  };
  const render = () => {
    const shownAccounts = visibleAccounts();
    $("#export-all").disabled = !state.accounts.some((account) => account.hasCredentials);
    $("#account-empty").hidden = shownAccounts.length > 0;
    $("#accounts").replaceChildren(...shownAccounts.map((account) => {
      const row = document.createElement("tr");
      const selection = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", "Select " + account.email);
      checkbox.checked = state.selectedEmails.has(account.email);
      checkbox.disabled = !account.hasCredentials || Boolean(state.activeJobId);
      if (!account.hasCredentials) {
        checkbox.title = "Add password and MFA credentials before running account actions.";
      }
      checkbox.onchange = () => {
        if (checkbox.checked) {
          state.selectedEmails.add(account.email);
        } else {
          state.selectedEmails.delete(account.email);
        }
        updateSelectionControls();
      };
      selection.append(checkbox);
      const email = document.createElement("td");
      email.className = "email-cell";
      email.textContent = account.email;
      const auth = document.createElement("td");
      auth.className = "auth-cell";
      const authProfiles = document.createElement("div");
      authProfiles.className = "auth-profiles";
      if (account.authProfiles.length === 0) {
        const missing = document.createElement("span");
        missing.className = "auth-missing";
        missing.textContent = "No auth file";
        authProfiles.append(missing);
      } else {
        for (const profile of account.authProfiles) {
          const item = document.createElement("span");
          item.className = "auth-profile" + (profile.isCurrent ? " current" : "");
          item.title = profile.valid ? "Codex auth profile" : "Auth profile is incomplete";
          const label = document.createElement("span");
          label.className = "auth-profile-label";
          label.textContent = profile.fileName + (profile.isCurrent ? " · CURRENT" : "");
          item.append(label);
          if (!profile.isCurrent) {
            const use = document.createElement("button");
            use.className = "profile-switch";
            use.textContent = "Switch";
            use.setAttribute("aria-label", "Switch to " + profile.fileName);
            use.title = profile.valid
              ? "Switch Codex App to this auth profile"
              : "This auth profile is incomplete";
            use.disabled = !profile.valid || Boolean(state.activeJobId);
            use.onclick = async () => {
              if (!confirm("Switch Codex App to " + profile.fileName + "? The app may restart.")) return;
              use.disabled = true;
              status("Switching Codex auth to " + profile.fileName + "…");
              try {
                const result = await request("/api/auth/use", {
                  method: "POST",
                  body: JSON.stringify({ profileName: profile.name }),
                });
                status(
                  "Switched Codex auth to " + profile.fileName
                    + (result.restarting ? ". Codex App is restarting." : "."),
                );
                await load();
              } catch (error) {
                status(error.message, true);
                use.disabled = false;
              }
            };
            item.append(use);
          }
          authProfiles.append(item);
        }
      }
      auth.append(authProfiles);
      const quota = createQuotaCell(account.quota);
      const availability = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + account.status;
      badge.textContent = statusLabels[account.status] || account.status;
      availability.append(badge);
      if (account.statusMessage || account.lastCheckedAt) {
        const checked = account.lastCheckedAt
          ? "Checked " + new Date(account.lastCheckedAt).toLocaleString()
          : "";
        availability.title = [account.statusMessage, checked].filter(Boolean).join(" · ");
      }
      const actions = document.createElement("td");
      actions.className = "actions";
      const actionButtons = document.createElement("div");
      actionButtons.className = "action-buttons";
      const busy = Boolean(state.activeJobId)
        || account.status === "checking"
        || account.status === "rotating";
      const edit = document.createElement("button");
      edit.className = "secondary icon-button";
      edit.setAttribute("aria-label", "Edit");
      edit.title = "Edit";
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>';
      edit.disabled = busy;
      edit.onclick = () => {
        state.selectedEmail = account.email;
        state.selectedHasCredentials = account.hasCredentials;
        $("#edit-card").hidden = false;
        $("#edit-title").textContent = account.hasCredentials
          ? "Edit account"
          : "Add credentials to auth-only account";
        $("#edit-help").textContent = account.hasCredentials
          ? "Leave password or MFA blank to keep the existing value. Use - to remove MFA."
          : "Enter the account password and MFA secret. Use - when MFA is not enabled.";
        $("#edit-form").email.value = account.email;
        $("#edit-form").password.value = "";
        $("#edit-form").mfaSecret.value = "";
        $("#edit-form").password.required = !account.hasCredentials;
        $("#edit-form").mfaSecret.required = !account.hasCredentials;
        $("#edit-form").password.focus();
      };
      const remove = document.createElement("button");
      remove.className = "danger icon-button";
      remove.setAttribute("aria-label", "Delete");
      remove.title = "Delete";
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m18 7-1 13H7L6 7"></path><path d="M10 11v5M14 11v5"></path></svg>';
      remove.disabled = busy;
      remove.onclick = async () => {
        const detail = account.hasCredentials
          ? "Delete stored credentials and archive linked auth profiles for "
          : "Archive auth profiles for ";
        if (!confirm(detail + account.email + "?")) return;
        try {
          await request("/api/accounts/" + encodeURIComponent(account.email), { method: "DELETE" });
          status("Deleted " + account.email);
          await load();
        } catch (error) { status(error.message, true); }
      };
      actionButtons.append(edit, remove);
      actions.append(actionButtons);
      const cells = [
        [selection, "Select"],
        [email, "Email"],
        [auth, "Codex auth"],
        [quota, "Quota"],
        [availability, "Credential check"],
        [actions, "Actions"],
      ];
      for (const [cell, label] of cells) {
        cell.dataset.label = label;
      }
      row.append(...cells.map(([cell]) => cell));
      return row;
    }));
    updateSelectionControls();
  };
  const load = async () => {
    try {
      const data = await request("/api/accounts");
      state.accounts = data.accounts;
      state.quota = data.quota || { status: "idle", lastUpdatedAt: null, error: null };
      const available = new Set(
        visibleAccounts()
          .filter((account) => account.hasCredentials)
          .map((account) => account.email),
      );
      state.selectedEmails = new Set(
        [...state.selectedEmails].filter((email) => available.has(email)),
      );
      $("#file-name").textContent = data.file.fileName;
      $("#quota-meta").textContent = state.quota.status === "running"
        ? "Quota loading…"
        : state.quota.lastUpdatedAt
          ? "Quota updated " + new Date(state.quota.lastUpdatedAt).toLocaleString()
          : "";
      render();
      if (!quotaAutoStarted && state.quota.status === "idle") {
        quotaAutoStarted = true;
        refreshQuota();
      }
    } catch (error) { status(error.message, true); }
  };
  $("#refresh").onclick = load;
  const selectAllAccounts = (checked) => {
    state.selectedEmails = checked
      ? new Set(
        visibleAccounts()
          .filter((account) => account.hasCredentials)
          .map((account) => account.email),
      )
      : new Set();
    render();
  };
  $("#select-all").onchange = (event) => selectAllAccounts(event.target.checked);
  $("#select-all-cards").onchange = (event) => selectAllAccounts(event.target.checked);
  $("#quota-filter").onchange = (event) => {
    state.quotaFilter = event.target.value;
    const shownEmails = new Set(visibleAccounts().map((account) => account.email));
    state.selectedEmails = new Set(
      [...state.selectedEmails].filter((email) => shownEmails.has(email)),
    );
    render();
  };
  $("#quota-sort").onclick = () => {
    const nextSort = state.quotaSort === "default"
      ? "asc"
      : state.quotaSort === "asc"
        ? "desc"
        : "default";
    state.quotaSort = nextSort;
    const indicator = nextSort === "asc" ? "↑" : nextSort === "desc" ? "↓" : "↕";
    $("#quota-sort").dataset.sort = nextSort;
    $("#quota-sort").setAttribute("aria-label", "Sort by quota: " + nextSort);
    $("#quota-sort").title = "Sort: " + nextSort[0].toUpperCase() + nextSort.slice(1);
    $("#quota-sort-indicator").textContent = indicator;
    render();
  };
  $("#export-all").onclick = async () => {
    if (!confirm("Export all passwords and MFA secrets to a plaintext file?")) return;
    const button = $("#export-all");
    button.disabled = true;
    try {
      const response = await fetch("/api/accounts/export");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Export failed");
      }
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const fileName = match ? match[1] : "codex-accounts.txt";
      const downloadUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      const exportedCount = state.accounts.filter((account) => account.hasCredentials).length;
      status("Exported " + exportedCount + " account(s) to " + fileName + ".");
    } catch (error) {
      status(error.message, true);
    } finally {
      button.disabled = !state.accounts.some((account) => account.hasCredentials);
    }
  };
  $("#add-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await request("/api/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) });
      event.target.reset();
      status("Account added.");
      await load();
    } catch (error) { status(error.message, true); }
  };
  $("#import-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const data = await request("/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({ accounts: form.get("accounts") }),
      });
      event.target.reset();
      status("Imported " + data.imported + " accounts.");
      await load();
    } catch (error) { status(error.message, true); }
  };
  $("#edit-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const payload = state.selectedHasCredentials
      ? {}
      : {
        email: state.selectedEmail,
        password: form.get("password"),
        mfaSecret: form.get("mfaSecret"),
      };
    if (state.selectedHasCredentials && form.get("password")) {
      payload.password = form.get("password");
    }
    if (state.selectedHasCredentials && form.get("mfaSecret")) {
      payload.mfaSecret = form.get("mfaSecret");
    }
    try {
      const endpoint = state.selectedHasCredentials
        ? "/api/accounts/" + encodeURIComponent(state.selectedEmail)
        : "/api/accounts";
      await request(endpoint, {
        method: state.selectedHasCredentials ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      $("#edit-card").hidden = true;
      status(state.selectedHasCredentials ? "Account updated." : "Credentials added.");
      await load();
    } catch (error) { status(error.message, true); }
  };
  $("#cancel-edit").onclick = () => { $("#edit-card").hidden = true; };
  const refreshQuota = async () => {
    try {
      const data = await request("/api/quota/refresh", {
        method: "POST",
        body: "{}",
      });
      state.activeJobId = data.job.id;
      state.quota.status = "running";
      updateSelectionControls();
      $("#quota-meta").textContent = "Quota loading…";
      status("Refreshing quota for all Codex auth profiles.");
      pollJob(data.job.id);
    } catch (error) {
      status(error.message, true);
    }
  };
  const pollJob = async (jobId) => {
    try {
      const jobs = await request("/api/jobs");
      const job = jobs.jobs.find((candidate) => candidate.id === jobId);
      await load();
      if (!job || job.status === "running") {
        setTimeout(() => pollJob(jobId), 1000);
        return;
      }
      state.activeJobId = null;
      render();
      const label = job.type === "check"
        ? "Credential check"
        : job.type === "auth"
          ? "Get Auth"
          : job.type === "quota"
            ? "Quota"
            : "Rotation";
      const accountErrors = (job.result?.accounts || [])
        .filter((account) => account.error)
        .map((account) => account.email + ": " + account.error);
      const details = [job.error, ...accountErrors, job.result?.quotaRefreshError]
        .filter(Boolean);
      status(
        label + " " + job.status + (details.length ? ":\\n" + details.join("\\n") : ""),
        job.status !== "success" || details.length > 0,
      );
    } catch (error) { status(error.message, true); }
  };
  const startJob = async (type, emails) => {
    if (!Array.isArray(emails) || emails.length === 0) return;
    const target = emails.length === 1
      ? emails[0]
      : emails.length + " selected accounts";
    if (type === "rotation" && !confirm("Generate and change the password for " + target + "?")) return;
    if (type === "auth" && !confirm("Get or refresh Codex auth for " + target + "?")) return;
    try {
      const endpoint = type === "check"
        ? "/api/check"
        : type === "auth"
          ? "/api/auth/acquire"
          : "/api/rotate";
      const data = await request(endpoint, {
        method: "POST",
        body: JSON.stringify({ emails }),
      });
      state.activeJobId = data.job.id;
      updateSelectionControls();
      const action = type === "check"
        ? "Checking credentials for "
        : type === "auth"
          ? "Validating or repairing Codex auth for "
          : "Rotating ";
      const detail = type === "auth"
        ? ". Revoked sessions will open a fresh visible incognito Chrome window."
        : " in a fresh visible incognito Chrome session.";
      status(action + target + detail);
      await load();
      pollJob(data.job.id);
    } catch (error) { status(error.message, true); }
  };
  $("#check-all").onclick = () => startJob("check", [...state.selectedEmails]);
  $("#rotate-all").onclick = () => startJob("rotation", [...state.selectedEmails]);
  $("#auth-all").onclick = () => startJob("auth", [...state.selectedEmails]);
  $("#quota-refresh").onclick = refreshQuota;
  $("#view-list").onclick = () => setViewMode("list");
  $("#view-cards").onclick = () => setViewMode("cards");
  setViewMode(state.viewMode, { persist: false });
  load();
})();
</script>
</body>
</html>`;

async function startDashboard(options = {}) {
  const dashboard = createDashboardServer(options);
  const listening = await dashboard.listen();
  return { ...dashboard, ...listening };
}

module.exports = {
  accountSummary,
  createDashboardServer,
  maskSecret,
  parsePort,
  startDashboard,
};
