const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

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
const rotationCalls = [];
const rotationInputs = [];
const checkCalls = [];
const authCalls = [];
const archiveAuthCalls = [];
const switchCalls = [];
let quotaCalls = 0;
const authProfiles = [{
  name: "first-auth",
  fileName: "first-auth.json",
  email: "first@example.com",
  isCurrent: true,
  valid: true,
  error: null,
}, {
  name: "orphan-auth",
  fileName: "orphan-auth.json",
  email: "orphan@example.com",
  isCurrent: false,
  valid: true,
  error: null,
}];
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
  rotate: async (args, io) => {
    rotationCalls.push(args);
    const input = fs.readFileSync(args[0], "utf8");
    rotationInputs.push(input);
    const outputIndex = args.indexOf("--output") + 1;
    const rotated = input.replace(
      /^([^|\r\n]+\|)[^|\r\n]*(\|.*)$/gm,
      "$1Rotated-password-999!$2",
    );
    for (const line of rotated.trim().split(/\r?\n/)) {
      await io.onPasswordSubmitted({
        email: line.split("|", 1)[0],
        password: "Rotated-password-999!",
      });
    }
    fs.writeFileSync(args[outputIndex], rotated, { mode: 0o600 });
    return {
      success: 1,
      failed: 0,
    };
  },
  check: async (records, _options, io) => {
    checkCalls.push(records.map((record) => record.email));
    const results = records.map((record) => ({
      email: record.email,
      status: record.email.startsWith("bulk-two") ? "banned" : "active",
      message: record.email.startsWith("bulk-two")
        ? "The OpenAI account is disabled, suspended, or banned."
        : "Login succeeded.",
    }));
    for (const result of results) {
      io.onAccountStatus(result);
    }
    const success = results.filter((result) => result.status === "active").length;
    return {
      total: results.length,
      success,
      failed: results.length - success,
      results,
    };
  },
  getAuthProfiles: () => authProfiles,
  switchProfile: async (profileName) => {
    switchCalls.push(profileName);
    for (const profile of authProfiles) {
      profile.isCurrent = profile.name === profileName;
    }
    return { profile: profileName, restarting: false };
  },
  readQuotas: async () => {
    quotaCalls += 1;
    return [{
      profile: "first-auth",
      weekRemainingPercent: 73,
      weekResetsAt: "2030-01-01T00:00:00.000Z",
      resetCreditsAvailable: 2,
      resetCreditsNextExpiry: "2030-01-31T00:00:00.000Z",
      otherWindows: [],
      error: null,
    }, {
      profile: "orphan-auth",
      weekRemainingPercent: null,
      weekResetsAt: null,
      resetCreditsAvailable: 1,
      resetCreditsNextExpiry: null,
      otherWindows: [{
        durationMins: 43_200,
        remainingPercent: 55,
        resetsAt: "2030-02-01T00:00:00.000Z",
      }],
      error: null,
    }];
  },
  archiveAuth: (email) => {
    archiveAuthCalls.push(email);
    const removed = authProfiles.filter(
      (profile) => profile.email?.toLowerCase() === email.toLowerCase(),
    );
    for (const profile of removed) {
      authProfiles.splice(authProfiles.indexOf(profile), 1);
    }
    return removed.map((profile) => ({
      fileName: profile.fileName,
      archiveName: `archived-${profile.fileName}`,
    }));
  },
  acquireAuth: async (record, options) => {
    authCalls.push({
      email: record.email,
      hasHeadless: Object.hasOwn(options, "headless"),
    });
    const profile = {
      name: `${record.email.split("@", 1)[0]}-auth`,
      fileName: `${record.email.split("@", 1)[0]}-auth.json`,
      email: record.email,
      isCurrent: false,
      valid: true,
      error: null,
    };
    if (!authProfiles.some((candidate) => candidate.email === record.email)) {
      authProfiles.push(profile);
    }
    return profile;
  },
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

    const dashboardPage = await fetch(listening.url);
    assert.equal(dashboardPage.status, 200);
    const sessionCookie = dashboardPage.headers.get("set-cookie");
    assert.match(sessionCookie, /^codex_dashboard_session=/);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Strict/i);
    const reloadedPage = await fetch(`${baseUrl}/`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(reloadedPage.status, 200);
    const cookieAuthenticated = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(cookieAuthenticated.status, 200);

    const listed = await request("/api/accounts");
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.accounts.length, 2);
    assert.equal(listedBody.accounts[0].email, "first@example.com");
    assert.equal(listedBody.accounts[0].hasCredentials, true);
    assert.equal(listedBody.accounts[0].password, "••••••••");
    assert.equal(listedBody.accounts[0].mfa, "••••••••");
    assert.equal(listedBody.accounts[0].status, "unchecked");
    assert.equal(listedBody.accounts[0].authStatus, "available");
    assert.deepEqual(listedBody.accounts[0].authProfiles, [{
      name: "first-auth",
      fileName: "first-auth.json",
      isCurrent: true,
      valid: true,
    }]);
    assert.equal(listedBody.accounts[1].email, "orphan@example.com");
    assert.equal(listedBody.accounts[1].hasCredentials, false);
    assert.equal(listedBody.accounts[1].password, "-");
    assert.equal(listedBody.accounts[1].mfa, "-");
    assert.equal(listedBody.accounts[1].status, "auth_only");
    assert.deepEqual(listedBody.accounts[1].authProfiles, [{
      name: "orphan-auth",
      fileName: "orphan-auth.json",
      isCurrent: false,
      valid: true,
    }]);
    assert.equal(listedBody.accounts[0].quota, null);
    assert.equal(listedBody.quota.status, "idle");
    assert.equal(listedBody.automation, undefined);
    assert.doesNotMatch(JSON.stringify(listedBody), /Current-password-123|JBSWY3D/);

    const switched = await request("/api/auth/use", {
      method: "POST",
      body: JSON.stringify({ profileName: "orphan-auth" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), {
      profile: "orphan-auth",
      restarting: false,
    });
    assert.deepEqual(switchCalls, ["orphan-auth"]);
    assert.equal(authProfiles.find((profile) => profile.name === "orphan-auth").isCurrent, true);

    const missingSwitch = await request("/api/auth/use", {
      method: "POST",
      body: JSON.stringify({ profileName: "missing-auth" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(missingSwitch.status, 404);

    const quotaRefresh = await request("/api/quota/refresh", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    assert.equal(quotaRefresh.status, 202);
    const quotaRefreshBody = await quotaRefresh.json();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(quotaCalls, 1);
    const afterQuota = await request("/api/accounts");
    const afterQuotaBody = await afterQuota.json();
    assert.equal(afterQuotaBody.quota.status, "success");
    assert.ok(afterQuotaBody.quota.lastUpdatedAt);
    assert.deepEqual(afterQuotaBody.accounts[0].quota, {
      profile: "first-auth",
      weekRemainingPercent: 73,
      weekResetsAt: "2030-01-01T00:00:00.000Z",
      resetCreditsAvailable: 2,
      resetCreditsNextExpiry: "2030-01-31T00:00:00.000Z",
      otherWindows: [],
      error: null,
    });
    assert.equal(afterQuotaBody.accounts[1].quota.otherWindows[0].remainingPercent, 55);
    const quotaJobs = await request("/api/jobs");
    assert.equal(
      (await quotaJobs.json()).jobs.find(
        (job) => job.id === quotaRefreshBody.job.id,
      ).status,
      "success",
    );

    const deletedAuthOnly = await request(
      `/api/accounts/${encodeURIComponent("orphan@example.com")}`,
      { method: "DELETE" },
    );
    assert.equal(deletedAuthOnly.status, 200);
    assert.deepEqual(await deletedAuthOnly.json(), {
      deleted: "orphan@example.com",
      credentialsDeleted: false,
      authProfilesArchived: 1,
    });
    assert.deepEqual(archiveAuthCalls, ["orphan@example.com"]);
    const afterAuthOnlyDelete = await request("/api/accounts");
    assert.deepEqual(
      (await afterAuthOnlyDelete.json()).accounts.map((account) => account.email),
      ["first@example.com"],
    );

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
    assert.equal((await added.json()).account.status, "unchecked");

    const getSecondAuth = await request("/api/auth/acquire", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(getSecondAuth.status, 202);
    const getSecondAuthBody = await getSecondAuth.json();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(authCalls, [{
      email: "second@example.com",
      hasHeadless: false,
    }]);
    const authJobs = await request("/api/jobs");
    assert.equal(
      (await authJobs.json()).jobs.find(
        (job) => job.id === getSecondAuthBody.job.id,
      ).status,
      "success",
    );
    const afterAuth = await request("/api/accounts");
    assert.equal(quotaCalls, 2);
    assert.equal(
      (await afterAuth.json()).accounts.find(
        (account) => account.email === "second@example.com",
      ).authProfiles[0].fileName,
      "second-auth.json",
    );

    const checkSecond = await request("/api/check", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(checkSecond.status, 202);
    const checkSecondBody = await checkSecond.json();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(checkCalls[0], ["second@example.com"]);
    const afterCheck = await request("/api/accounts");
    const checkedAccount = (await afterCheck.json()).accounts.find(
      (account) => account.email === "second@example.com",
    );
    assert.equal(checkedAccount.status, "active");
    assert.match(checkedAccount.statusMessage, /Login succeeded/);
    assert.ok(checkedAccount.lastCheckedAt);
    const checkJobs = await request("/api/jobs");
    assert.equal(
      (await checkJobs.json()).jobs.find((job) => job.id === checkSecondBody.job.id).status,
      "success",
    );

    const edited = await request(
      `/api/accounts/${encodeURIComponent("second@example.com")}`,
      {
        method: "PATCH",
        body: JSON.stringify({ password: "Changed-password-789!" }),
        headers: { "content-type": "application/json" },
      },
    );
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).account.status, "unchecked");

    const rotateSecond = await request("/api/rotate", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(rotateSecond.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(rotationInputs[0], /^second@example\.com\|Changed-password-789!\|-/);
    assert.doesNotMatch(rotationInputs[0], /first@example\.com/);
    const afterSingleRotation = await request("/api/accounts");
    assert.equal(
      (await afterSingleRotation.json()).accounts.find(
        (account) => account.email === "second@example.com",
      ).status,
      "active",
    );
    const exportedAfterRotation = await request("/api/accounts/export");
    assert.equal(exportedAfterRotation.status, 200);
    assert.equal(
      exportedAfterRotation.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.match(
      exportedAfterRotation.headers.get("content-disposition"),
      /^attachment; filename="codex-accounts-\d{8}T\d{6}Z\.txt"$/,
    );
    assert.equal(exportedAfterRotation.headers.get("cache-control"), "no-store");
    assert.equal(
      await exportedAfterRotation.text(),
      [
        "first@example.com|Current-password-123!|JBSWY3DPEHPK3PXP",
        "second@example.com|Rotated-password-999!|-",
        "",
      ].join("\n"),
    );

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
    assert.ok(rotationCalls[0].includes("--unattended"));
    assert.ok(rotationCalls[0].includes("--continue-on-error"));
    assert.equal(rotationCalls[0].includes("--headless"), false);
    assert.match(rotationCalls[0][2], /codex-dashboard-rotation-/);
    const jobs = await request("/api/jobs");
    const jobsBody = await jobs.json();
    assert.equal(jobsBody.jobs.find((job) => job.id === rotationBody.job.id).status, "success");
    const rotationAgain = await request("/api/rotate", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    assert.equal(rotationAgain.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(rotationCalls.length, 3);

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

    const checkImported = await request("/api/check", {
      method: "POST",
      body: JSON.stringify({
        emails: ["bulk-one@example.com", "bulk-two@example.com"],
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(checkImported.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterImportedCheck = await request("/api/accounts");
    const checkedImportedAccounts = (await afterImportedCheck.json()).accounts;
    assert.equal(
      checkedImportedAccounts.find((account) => account.email === "bulk-one@example.com").status,
      "active",
    );
    assert.equal(
      checkedImportedAccounts.find((account) => account.email === "bulk-two@example.com").status,
      "banned",
    );

    const html = await request("/");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Codex account dashboard/);
    assert.ok(logs.length > 0);

    const legacyDbPath = path.join(root, "accounts.sqlite3");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password TEXT NOT NULL,
        mfa_secret TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.prepare(`
      INSERT INTO accounts (email, password, mfa_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      " legacy@example.com ",
      " Legacy-password-123! ",
      " - ",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    legacyDb.close();

    const sqliteDashboard = createDashboardServer({
      dbPath: legacyDbPath,
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
      assert.equal(sqliteBody.accounts[0].email, "legacy@example.com");
      assert.equal(sqliteBody.accounts[0].status, "unchecked");
      assert.match(
        sqliteBody.accounts[0].statusMessage,
        /credentials normalized/i,
      );
    } finally {
      await sqliteDashboard.close();
    }
    const normalizedDb = new Database(legacyDbPath, { readonly: true });
    const normalizedRow = normalizedDb.prepare(`
      SELECT email, password, mfa_secret AS mfaSecret
      FROM accounts
    `).get();
    normalizedDb.close();
    assert.deepEqual(normalizedRow, {
      email: "legacy@example.com",
      password: "Legacy-password-123!",
      mfaSecret: "-",
    });

    const interruptedDb = new Database(legacyDbPath);
    interruptedDb.prepare(`
      UPDATE accounts
      SET status = 'rotating',
          status_message = 'The new password was submitted; waiting for confirmation.'
      WHERE email = ?
    `).run("legacy@example.com");
    interruptedDb.close();
    const recoveredDashboard = createDashboardServer({
      dbPath: legacyDbPath,
      port: 0,
      open: false,
      logger: { log() {}, error() {} },
    });
    try {
      const recoveredListening = await recoveredDashboard.listen();
      const recoveredBaseUrl = new URL(recoveredListening.url).origin;
      const recoveredResponse = await fetch(`${recoveredBaseUrl}/api/accounts`, {
        headers: { "x-dashboard-token": recoveredDashboard.token },
      });
      const recoveredBody = await recoveredResponse.json();
      assert.equal(recoveredBody.accounts[0].status, "rotation_unverified");
      assert.match(recoveredBody.accounts[0].statusMessage, /run Check/i);
    } finally {
      await recoveredDashboard.close();
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
