const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDashboardServer,
} = require("../lib/dashboard");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dashboard-test-"));
const accountFile = path.join(root, "accounts.txt");
fs.writeFileSync(
  accountFile,
  "first@example.com|Current-password-123!|JBSWY3DPEHPK3PXP\n",
  { mode: 0o600 },
);

const logs = [];
const dashboard = createDashboardServer({
  filePath: accountFile,
  port: 0,
  open: false,
  logger: {
    log(message) {
      logs.push(message);
    },
    error(message) {
      logs.push(message);
    },
  },
  rotate: async () => ({
    success: 1,
    failed: 0,
  }),
});

let baseUrl;
async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "x-dashboard-token": dashboard.token,
      ...(options.headers || {}),
    },
  });
}

(async () => {
  try {
    const listening = await dashboard.listen();
    baseUrl = new URL(listening.url).origin;
    const unauthenticated = await fetch(`${baseUrl}/api/accounts`);
    assert.equal(unauthenticated.status, 401);

    const listed = await request("/api/accounts");
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.accounts.length, 1);
    assert.equal(listedBody.accounts[0].email, "first@example.com");
    assert.equal(listedBody.accounts[0].password, "••••••••");
    assert.equal(listedBody.accounts[0].mfa, "••••••••");
    assert.doesNotMatch(JSON.stringify(listedBody), /Current-password-123|JBSWY3D/);

    const added = await request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: "second@example.com",
        password: "Current-password-456!",
        mfaSecret: "-",
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(added.status, 201);

    const edited = await request(
      `/api/accounts/${encodeURIComponent("second@example.com")}`,
      {
        method: "PATCH",
        body: JSON.stringify({ password: "Changed-password-789!" }),
        headers: { "content-type": "application/json" },
      },
    );
    assert.equal(edited.status, 200);

    const deleted = await request(
      `/api/accounts/${encodeURIComponent("second@example.com")}`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 200);

    const rotation = await request("/api/rotate", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    assert.equal(rotation.status, 202);
    const rotationBody = await rotation.json();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const jobs = await request("/api/jobs");
    const jobsBody = await jobs.json();
    assert.equal(jobsBody.jobs.find((job) => job.id === rotationBody.job.id).status, "success");

    const deletedLast = await request(
      `/api/accounts/${encodeURIComponent("first@example.com")}`,
      { method: "DELETE" },
    );
    assert.equal(deletedLast.status, 200);
    const emptyList = await request("/api/accounts");
    assert.deepEqual((await emptyList.json()).accounts, []);

    const imported = await request("/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({
        accounts: [
          "bulk-one@example.com|Bulk-password-123!|JBSWY3DPEHPK3PXP",
          "bulk-two@example.com|Bulk-password-456!|-",
        ].join("\n"),
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).imported, 2);

    const duplicateImport = await request("/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({
        accounts: [
          "bulk-one@example.com|Another-password-123!|-",
          "must-not-import@example.com|Another-password-456!|-",
        ].join("\n"),
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(duplicateImport.status, 400);
    const afterRejectedImport = await request("/api/accounts");
    const afterRejectedBody = await afterRejectedImport.json();
    assert.deepEqual(
      afterRejectedBody.accounts.map((account) => account.email),
      ["bulk-one@example.com", "bulk-two@example.com"],
    );

    const html = await request("/");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Codex account dashboard/);
    assert.ok(logs.length > 0);

    const sqliteDashboard = createDashboardServer({
      dbPath: path.join(root, "accounts.sqlite3"),
      port: 0,
      open: false,
      logger: { log() {}, error() {} },
    });
    try {
      assert.equal(sqliteDashboard.storageKind, "sqlite");
      const sqliteListening = await sqliteDashboard.listen();
      const sqliteBaseUrl = new URL(sqliteListening.url).origin;
      const sqliteResponse = await fetch(`${sqliteBaseUrl}/api/accounts`, {
        headers: { "x-dashboard-token": sqliteDashboard.token },
      });
      assert.equal(sqliteResponse.status, 200);
      const sqliteBody = await sqliteResponse.json();
      assert.equal(sqliteBody.file.storage, "sqlite");
      assert.deepEqual(sqliteBody.accounts, []);
    } finally {
      await sqliteDashboard.close();
    }

    console.log("Dashboard API test passed.");
  } finally {
    await dashboard.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
