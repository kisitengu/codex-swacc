const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDashboardServer } = require("../lib/dashboard");

function browserExecutable() {
  const candidates = [
    process.env.CODEX_ACCOUNT_BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const executablePath = browserExecutable();
if (!executablePath) {
  console.log("Dashboard browser test skipped: Chrome/Edge/Chromium was not found.");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dashboard-browser-"));
const accountFile = path.join(root, "accounts.txt");
fs.writeFileSync(
  accountFile,
  "first@example.com|Current-password-123!|JBSWY3DPEHPK3PXP\n",
  { mode: 0o600 },
);

const browserAuthProfiles = [{
  name: "first-auth",
  fileName: "first-auth.json",
  email: "first@example.com",
  isCurrent: true,
  valid: true,
  error: null,
}, {
  name: "orphan-auth",
  fileName: "orphan-profile-with-a-very-long-name.json",
  email: "orphan@example.com",
  isCurrent: false,
  valid: true,
  error: null,
}, {
  name: "empty-auth",
  fileName: "empty-auth.json",
  email: "empty@example.com",
  isCurrent: false,
  valid: true,
  error: null,
}];
const switchCalls = [];
const dashboard = createDashboardServer({
  filePath: accountFile,
  port: 0,
  open: false,
  logger: { log() {}, error() {} },
  check: async (records, _options, io) => {
    const results = records.map((record) => ({
      email: record.email,
      status: "active",
      message: "Login succeeded.",
    }));
    for (const result of results) {
      io.onAccountStatus(result);
    }
    return {
      total: results.length,
      success: results.length,
      failed: 0,
      results,
    };
  },
  rotate: async () => ({
    success: 1,
    failed: 0,
  }),
  getAuthProfiles: () => browserAuthProfiles,
  switchProfile: async (profileName) => {
    switchCalls.push(profileName);
    for (const profile of browserAuthProfiles) {
      profile.isCurrent = profile.name === profileName;
    }
    return { profile: profileName, restarting: false };
  },
  readQuotas: async () => [{
    profile: "first-auth",
    weekRemainingPercent: 73,
    weekResetsAt: "2030-01-01T00:00:00.000Z",
    resetCreditsAvailable: 2,
    resetCreditsNextExpiry: "2030-01-31T00:00:00.000Z",
    otherWindows: [],
    error: null,
  }, {
    profile: "empty-auth",
    weekRemainingPercent: 0,
    weekResetsAt: "2030-01-02T00:00:00.000Z",
    resetCreditsAvailable: 0,
    resetCreditsNextExpiry: null,
    otherWindows: [],
    error: null,
  }, {
    profile: "orphan-auth",
    weekRemainingPercent: null,
    weekResetsAt: null,
    resetCreditsAvailable: null,
    resetCreditsNextExpiry: null,
    otherWindows: [],
    error: "401 Unauthorized: invalidated oauth token; code=token_revoked",
  }],
  acquireAuth: async (record, options) => {
    assert.equal(Object.hasOwn(options, "headless"), false);
    const profile = {
      name: `${record.email.split("@", 1)[0]}-auth`,
      fileName: `${record.email.split("@", 1)[0]}-auth.json`,
      email: record.email,
      isCurrent: false,
      valid: true,
      error: null,
    };
    browserAuthProfiles.push(profile);
    return profile;
  },
});

(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { url } = await dashboard.listen();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 430, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });

    const firstRow = page.locator("tr").filter({ hasText: "first@example.com" });
    await firstRow.getByText("73%", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await firstRow.getByText(/^Reset /).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await firstRow.getByText(/2 credits/).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    assert.equal(await page.getByRole("columnheader", { name: "Password" }).count(), 0);
    assert.equal(await page.getByRole("columnheader", { name: "MFA" }).count(), 0);
    assert.equal(await page.getByRole("columnheader", { name: "Resets" }).count(), 0);
    assert.equal(await firstRow.locator("td").count(), 6);
    const quotaFilter = page.getByRole("combobox", { name: "Filter by quota" });
    await quotaFilter.selectOption("available");
    assert.deepEqual(await page.locator("#accounts .email-cell").allTextContents(), ["first@example.com"]);
    await quotaFilter.selectOption("exhausted");
    assert.deepEqual(await page.locator("#accounts .email-cell").allTextContents(), ["empty@example.com"]);
    await quotaFilter.selectOption("all");
    const quotaSort = page.getByRole("button", { name: "Sort by quota: default" });
    await quotaSort.click();
    assert.deepEqual(
      await page.locator("#accounts .email-cell").allTextContents(),
      ["empty@example.com", "first@example.com", "orphan@example.com"],
    );
    await page.getByRole("button", { name: "Sort by quota: asc" }).click();
    assert.deepEqual(
      await page.locator("#accounts .email-cell").allTextContents(),
      ["first@example.com", "empty@example.com", "orphan@example.com"],
    );
    await page.getByRole("button", { name: "Sort by quota: desc" }).click();
    assert.deepEqual(
      await page.locator("#accounts .email-cell").allTextContents(),
      ["first@example.com", "empty@example.com", "orphan@example.com"],
    );
    const authOnlyRow = page.locator("tr").filter({ hasText: "orphan@example.com" });
    await authOnlyRow.getByText("Auth only", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await authOnlyRow.getByText("Auth revoked", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    assert.equal(
      await authOnlyRow.getByRole("checkbox", { name: "Select orphan@example.com" }).isDisabled(),
      true,
    );
    assert.equal(await authOnlyRow.getByRole("button", { name: "Edit" }).count(), 1);
    assert.equal(await authOnlyRow.getByRole("button", { name: "Delete" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "List" }).getAttribute("aria-pressed"), "true");
    const listGeometry = await authOnlyRow.evaluate((row) => {
      const cell = row.querySelector(".auth-cell").getBoundingClientRect();
      const profile = row.querySelector(".auth-profile").getBoundingClientRect();
      const button = row.querySelector(".profile-switch").getBoundingClientRect();
      return {
        cellRight: cell.right,
        profileRight: profile.right,
        buttonRight: button.right,
      };
    });
    assert.ok(listGeometry.profileRight <= listGeometry.cellRight + 1, JSON.stringify(listGeometry));
    assert.ok(listGeometry.buttonRight <= listGeometry.cellRight + 1, JSON.stringify(listGeometry));
    await page.getByRole("button", { name: "Cards" }).click();
    await page.locator("#account-view.cards-view").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => localStorage.getItem("codex-account-dashboard-view")), "cards");
    assert.equal(await firstRow.evaluate((row) => getComputedStyle(row).display), "grid");
    assert.ok((await firstRow.boundingBox()).height < 300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const cardSelectAll = page.getByRole("checkbox", { name: "Select all accounts in cards" });
    await cardSelectAll.check();
    assert.equal(await page.getByRole("button", { name: "Check credentials (1)" }).count(), 1);
    await cardSelectAll.uncheck();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    assert.equal(await page.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "List" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await authOnlyRow.getByRole("button", { name: "Switch to orphan-profile-with-a-very-long-name.json" }).click();
    await authOnlyRow.getByText("orphan-profile-with-a-very-long-name.json · CURRENT", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    assert.deepEqual(switchCalls, ["orphan-auth"]);
    assert.equal(
      await authOnlyRow.locator(".action-buttons").evaluate(
        (element) => getComputedStyle(element).flexWrap,
      ),
      "nowrap",
    );
    await authOnlyRow.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(
      await page.getByRole("heading", { name: "Add credentials to auth-only account" }).count(),
      1,
    );
    assert.equal(
      await page.locator('#edit-form input[name="password"]').getAttribute("required"),
      "",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const addEmail = page.locator('#add-form input[name="email"]');
    await addEmail.fill("ui@example.com");
    await page.locator('#add-form input[name="password"]').fill("UI-password-456!");
    await page.locator('#add-form input[name="mfaSecret"]').fill("-");
    await page.getByRole("button", { name: "Add account", exact: true }).click();

    const addedAccount = page.getByText("ui@example.com", { exact: true });
    await page.waitForTimeout(500);
    if (!(await addedAccount.isVisible())) {
      throw new Error(
        `Dashboard add failed: status=${await page.locator("#status").innerText()} `
        + `accounts=${await page.locator("#accounts").innerText()}`,
      );
    }
    assert.equal(await page.getByRole("button", { name: "Check credentials (0)", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Rotate (0)", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Get Auth (0)", exact: true }).count(), 1);
    assert.equal(
      (await page.getByRole("button", { name: "Export accounts", exact: true }).count()),
      1,
    );
    const addedRow = page.locator("tr").filter({ hasText: "ui@example.com" });
    assert.equal(await addedRow.getByRole("button", { name: "Edit" }).count(), 1);
    assert.equal(await addedRow.getByRole("button", { name: "Delete" }).count(), 1);
    await addedRow.getByText("Not checked", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await addedRow.getByRole("checkbox", { name: "Select ui@example.com" }).check();
    await page.getByRole("button", { name: "Check credentials (1)", exact: true }).click();
    await addedRow.getByText("Credentials valid", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Get Auth (1)", exact: true }).click();
    await page.getByText("Get Auth success", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await addedRow.getByText("ui-auth.json", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Rotate (1)", exact: true }).click();
    await page.getByText("Rotation success", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Current-password-123|JBSWY3D|UI-password-456/);

    const editButtons = page.getByRole("button", { name: "Edit", exact: true });
    assert.equal(await editButtons.count(), 4);
    await editButtons.nth(1).click();
    await page.locator('#edit-form input[name="password"]').fill("UI-password-789!");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText("Account updated.", { exact: true }).waitFor({
      state: "visible",
      timeoutMs: 10_000,
    });

    await page.locator('#import-form textarea[name="accounts"]').fill(
      "bulk-ui-one@example.com|Bulk-UI-password-123!|-\n"
        + "bulk-ui-two@example.com|Bulk-UI-password-456!|JBSWY3DPEHPK3PXP",
    );
    await page.getByRole("button", { name: "Import accounts", exact: true }).click();
    await page.getByText("Imported 2 accounts.", { exact: true }).waitFor({
      state: "visible",
      timeoutMs: 10_000,
    });
    assert.equal(
      await page.getByText("bulk-ui-one@example.com", { exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByText("bulk-ui-two@example.com", { exact: true }).count(),
      1,
    );
    await page.getByRole("checkbox", { name: "Select all accounts" }).check();
    assert.equal(await page.getByRole("button", { name: "Check credentials (4)", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Rotate (4)", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Get Auth (4)", exact: true }).count(), 1);

    page.once("dialog", (dialog) => dialog.accept());
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export accounts", exact: true }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^codex-accounts-\d{8}T\d{6}Z\.txt$/);
    const exported = fs.readFileSync(await download.path(), "utf8");
    assert.match(exported, /ui@example\.com\|UI-password-789!\|-/);
    assert.match(exported, /bulk-ui-one@example\.com\|Bulk-UI-password-123!\|-/);

    const saved = fs.readFileSync(accountFile, "utf8");
    assert.match(saved, /ui@example\.com\|UI-password-789!\|-/);
    assert.match(saved, /bulk-ui-one@example\.com\|Bulk-UI-password-123!\|-/);
    assert.match(
      saved,
      /bulk-ui-two@example\.com\|Bulk-UI-password-456!\|JBSWY3DPEHPK3PXP/,
    );
    console.log("Dashboard browser test passed.");
  } finally {
    await browser.close();
    await dashboard.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
