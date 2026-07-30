"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
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

const MAX_BODY_BYTES = 1_000_000;

function maskSecret(value) {
  if (!value || value === "-") {
    return value === "-" ? "-" : "not set";
  }
  return "••••••••";
}

function accountSummary(record) {
  return {
    email: record.email,
    password: maskSecret(record.password),
    mfa: record.mfaSecret === "-" ? "-" : maskSecret(record.mfaSecret),
    mfaEnabled: record.mfaSecret !== "-",
  };
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

function sendHtml(response) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
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
    || url.searchParams.get("token");
}

function unauthorized(response) {
  sendJson(response, 401, { error: "Dashboard session token is required." });
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

function createDashboardServer({
  filePath,
  dbPath = defaultDatabasePath(),
  port = 0,
  open = true,
  rotate = rotatePasswords,
  logger = console,
} = {}) {
  const store = filePath
    ? createFileAccountStore(filePath)
    : createSqliteAccountStore(dbPath);
  const token = crypto.randomBytes(32).toString("hex");
  const jobs = new Map();
  let server;

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/accounts" && request.method === "GET") {
      const records = store.read();
      sendJson(response, 200, {
        file: dashboardHtmlState(store.filePath, store.kind),
        accounts: records.map(accountSummary),
      });
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
      if (index < 0) {
        throw new Error(`Account not found: ${email}`);
      }

      if (request.method === "DELETE") {
        store.remove(email);
        sendJson(response, 200, { deleted: email });
        return;
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

    if (url.pathname === "/api/rotate" && request.method === "POST") {
      const running = [...jobs.values()].find((job) => job.status === "running");
      if (running) {
        throw new Error("A password rotation is already running.");
      }
      const payload = await readJsonBody(request);
      const records = store.read();
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
      const id = crypto.randomUUID();
      const job = {
        id,
        status: "running",
        file: path.basename(store.filePath),
        output: path.basename(store.filePath),
        startedAt: new Date().toISOString(),
      };
      jobs.set(id, job);
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
      }).then((result) => {
        if (fs.existsSync(outputPath)) {
          store.replace(parseCredentialList(fs.readFileSync(outputPath, "utf8")));
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
      sendHtml(response);
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
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    p, .muted { color: #9ca3af; }
    .card { background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 18px; margin-top: 18px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { border: 0; border-radius: 8px; padding: 9px 13px; cursor: pointer; color: white; background: #2563eb; font-weight: 600; }
    button.secondary { background: #4b5563; }
    button.danger { background: #b91c1c; }
    button:disabled { opacity: .5; cursor: wait; }
    input, textarea { width: 100%; box-sizing: border-box; background: #111827; color: #f9fafb; border: 1px solid #4b5563; border-radius: 7px; padding: 9px 10px; }
    textarea { resize: vertical; min-height: 130px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    label { display: grid; gap: 6px; color: #d1d5db; font-size: 13px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 8px; border-bottom: 1px solid #374151; text-align: left; vertical-align: middle; }
    th { color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    td code { color: #bfdbfe; font-size: 13px; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; }
    #status { min-height: 22px; margin-top: 12px; color: #93c5fd; white-space: pre-wrap; }
    .warning { color: #fbbf24; }
    @media (max-width: 720px) { th:nth-child(3), td:nth-child(3) { display: none; } main { padding: 22px 12px 48px; } }
  </style>
</head>
<body>
<main>
  <h1>Codex account dashboard</h1>
  <p>Local-only manager for <code id="file-name"></code>. Passwords and MFA secrets stay masked in this view.</p>
  <div class="card">
    <div class="toolbar">
      <button id="refresh">Refresh</button>
      <button id="rotate">Rotate passwords</button>
      <span class="muted" id="account-count"></span>
    </div>
    <div id="status"></div>
  </div>
  <div class="card">
    <h2>Accounts</h2>
    <table>
      <thead><tr><th>Email</th><th>Password</th><th>MFA</th><th>Actions</th></tr></thead>
      <tbody id="accounts"></tbody>
    </table>
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
    <h2>Edit account</h2>
    <p class="muted">Leave password or MFA blank to keep the existing value. Use <code>-</code> to remove MFA.</p>
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
  const token = queryToken || sessionStorage.getItem("codexDashboardToken");
  if (queryToken) {
    sessionStorage.setItem("codexDashboardToken", queryToken);
    history.replaceState({}, "", "/");
  }
  const headers = { "x-dashboard-token": token, "content-type": "application/json" };
  const state = { accounts: [], selectedEmail: null };
  const $ = (selector) => document.querySelector(selector);
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
  const render = () => {
    $("#account-count").textContent = state.accounts.length + " account(s)";
    $("#accounts").replaceChildren(...state.accounts.map((account) => {
      const row = document.createElement("tr");
      const email = document.createElement("td");
      email.textContent = account.email;
      const password = document.createElement("td");
      password.innerHTML = "<code>••••••••</code>";
      const mfa = document.createElement("td");
      mfa.textContent = account.mfa === "-" ? "-" : "••••••••";
      const actions = document.createElement("td");
      actions.className = "actions";
      const edit = document.createElement("button");
      edit.className = "secondary";
      edit.textContent = "Edit";
      edit.onclick = () => {
        state.selectedEmail = account.email;
        $("#edit-card").hidden = false;
        $("#edit-form").email.value = account.email;
        $("#edit-form").password.value = "";
        $("#edit-form").mfaSecret.value = "";
        $("#edit-form").password.focus();
      };
      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.onclick = async () => {
        if (!confirm("Delete " + account.email + "?")) return;
        try {
          await request("/api/accounts/" + encodeURIComponent(account.email), { method: "DELETE" });
          status("Deleted " + account.email);
          await load();
        } catch (error) { status(error.message, true); }
      };
      actions.append(edit, remove);
      row.append(email, password, mfa, actions);
      return row;
    }));
  };
  const load = async () => {
    try {
      const data = await request("/api/accounts");
      state.accounts = data.accounts;
      $("#file-name").textContent = data.file.fileName;
      render();
    } catch (error) { status(error.message, true); }
  };
  $("#refresh").onclick = load;
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
    const payload = {};
    if (form.get("password")) payload.password = form.get("password");
    if (form.get("mfaSecret")) payload.mfaSecret = form.get("mfaSecret");
    try {
      await request("/api/accounts/" + encodeURIComponent(state.selectedEmail), { method: "PATCH", body: JSON.stringify(payload) });
      $("#edit-card").hidden = true;
      status("Account updated.");
      await load();
    } catch (error) { status(error.message, true); }
  };
  $("#cancel-edit").onclick = () => { $("#edit-card").hidden = true; };
  $("#rotate").onclick = async () => {
    if (!confirm("Automatically generate and change passwords for all accounts?")) return;
    try {
      const data = await request("/api/rotate", { method: "POST", body: JSON.stringify({}) });
      status("Automatic rotation started. Accounts blocked by unsupported provider verification will be marked failed while the remaining accounts continue.");
      $("#rotate").disabled = true;
      const poll = async () => {
        const jobs = await request("/api/jobs");
        const job = jobs.jobs.find((candidate) => candidate.id === data.job.id);
        if (!job || job.status === "running") { setTimeout(poll, 1000); return; }
        $("#rotate").disabled = false;
        status("Rotation " + job.status + (job.error ? ": " + job.error : ""));
      };
      poll();
    } catch (error) { status(error.message, true); }
  };
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
