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

const dashboard = createDashboardServer({
  filePath: accountFile,
  port: 0,
  open: false,
  logger: { log() {}, error() {} },
});

(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { url } = await dashboard.listen();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

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
    assert.equal(
      (await page.getByRole("button", { name: "Rotate passwords", exact: true }).count()),
      1,
    );
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Current-password-123|JBSWY3D|UI-password-456/);

    const editButtons = page.getByRole("button", { name: "Edit", exact: true });
    assert.equal(await editButtons.count(), 2);
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
