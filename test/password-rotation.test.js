const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  accountStatusFromError,
  formatCredentialList,
  generatePassword,
  generateTotp,
  launchRotationBrowser,
  parseCredentialList,
  parseRotationArgs,
} = require("../lib/password-rotation");

const parsed = parseCredentialList(
  [
    "# local credentials",
    "  first@example.com  |  old|password  |JBSWY3DPEHPK3PXP",
    "second@example.com|another-password|-",
  ].join("\n"),
);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].password, "old|password");
assert.equal(
  formatCredentialList(parsed),
  "first@example.com|old|password|JBSWY3DPEHPK3PXP\n"
    + "second@example.com|another-password|-\n",
);

assert.throws(
  () => parseCredentialList("first@example.com|password|not-base32!"),
  /Invalid MFA secret/,
);
assert.throws(
  () => parseCredentialList(
    "first@example.com|password|JBSWY3DPEHPK3PXP\n"
      + "FIRST@example.com|password|JBSWY3DPEHPK3PXP",
  ),
  /Duplicate account/,
);

const generated = generatePassword(24);
assert.equal(generated.length, 24);
assert.match(generated, /[A-Z]/);
assert.match(generated, /[a-z]/);
assert.match(generated, /[0-9]/);
assert.match(generated, /[!@#$%^&*_\-+=]/);
assert.doesNotMatch(generated, /[|\s]/);

assert.equal(
  generateTotp(
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    59_000,
    { digits: 8 },
  ),
  "94287082",
);

const parseCwd = path.resolve(os.tmpdir(), "codex-acc-test");
const options = parseRotationArgs([
  "accounts.txt",
  "--output",
  "out.txt",
  "--password-length",
  "32",
  "--skip-verify",
  "--unattended",
  "--yes",
], parseCwd);
assert.equal(options.inputPath, path.join(parseCwd, "accounts.txt"));
assert.equal(options.outputPath, path.join(parseCwd, "out.txt"));
assert.equal(options.passwordLength, 32);
assert.equal(options.verifyLogin, false);
assert.equal(options.unattended, true);
assert.equal(options.yes, true);
const previousHeadlessEnvironment = process.env.CODEX_ACCOUNT_HEADLESS;
process.env.CODEX_ACCOUNT_HEADLESS = "1";
assert.equal(
  Object.hasOwn(parseRotationArgs(["accounts.txt"], parseCwd), "headless"),
  false,
);
if (previousHeadlessEnvironment === undefined) {
  delete process.env.CODEX_ACCOUNT_HEADLESS;
} else {
  process.env.CODEX_ACCOUNT_HEADLESS = previousHeadlessEnvironment;
}
assert.throws(
  () => parseRotationArgs(["accounts.txt", "--headless"], parseCwd),
  /Unknown rotate-passwords option: --headless/,
);
assert.throws(
  () => parseRotationArgs(["accounts.txt", "--visible"], parseCwd),
  /Unknown rotate-passwords option: --visible/,
);

async function testPrivateBrowserLaunch() {
  let capturedProfilePath = null;
  let capturedLaunchOptions = null;
  let contextClosed = false;
  const launchedBrowser = await launchRotationBrowser(
    {
      headless: true,
      browserChannel: "chrome",
      browserExecutable: null,
    },
    {
      launchPersistentContext: async (profilePath, launchOptions) => {
        capturedProfilePath = profilePath;
        capturedLaunchOptions = launchOptions;
        return {
          pages: () => [],
          newPage: async () => ({}),
          close: async () => {
            contextClosed = true;
          },
        };
      },
    },
  );
  const context = await launchedBrowser.newContext({ locale: "en-US" });
  assert.match(capturedProfilePath, /codex-account-private-/);
  assert.ok(capturedLaunchOptions.args.includes("--incognito"));
  assert.ok(capturedLaunchOptions.args.includes("--new-window"));
  assert.equal(capturedLaunchOptions.headless, false);
  assert.deepEqual(capturedLaunchOptions.ignoreDefaultArgs, ["--enable-automation"]);
  assert.equal(capturedLaunchOptions.locale, "en-US");
  await context.close();
  await launchedBrowser.close();
  assert.equal(contextClosed, true);
}

const privateBrowserLaunchTest = testPrivateBrowserLaunch();

assert.equal(
  accountStatusFromError(Object.assign(new Error("disabled"), { accountStatus: "banned" })),
  "banned",
);
assert.equal(accountStatusFromError(new Error("The current password was rejected.")), "invalid_credentials");
assert.equal(
  accountStatusFromError(new Error("Incorrect email address or password")),
  "invalid_credentials",
);
assert.equal(accountStatusFromError(new Error("Invalid content type: text/html")), "auth_error");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-password-test-"));
const inputPath = path.join(root, "accounts.txt");
const fakePassword = "fake-current-password";
const fakeMfa = "JBSWY3DPEHPK3PXP";
fs.writeFileSync(
  inputPath,
  `dry-run@example.com|${fakePassword}|${fakeMfa}\n`,
  { mode: 0o600 },
);

const cli = path.resolve(__dirname, "..", "bin", "codex-account.js");
const result = spawnSync(
  process.execPath,
  [cli, "rotate-passwords", inputPath, "--dry-run"],
  { encoding: "utf8" },
);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /Validated 1 account/);
assert.match(result.stdout, /Dry run complete/);
assert.doesNotMatch(result.stdout, new RegExp(fakePassword));
assert.doesNotMatch(result.stdout, new RegExp(fakeMfa));
assert.equal(
  fs.existsSync(path.join(root, "accounts.rotated.txt")),
  false,
  "dry-run must not write a rotated credential file",
);

fs.rmSync(root, { recursive: true, force: true });
privateBrowserLaunchTest.then(() => {
  console.log("Password rotation tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
