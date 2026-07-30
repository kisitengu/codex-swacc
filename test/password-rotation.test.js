const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  formatCredentialList,
  generatePassword,
  generateTotp,
  parseCredentialList,
  parseRotationArgs,
} = require("../lib/password-rotation");

const parsed = parseCredentialList(
  [
    "# local credentials",
    "first@example.com|old|password|JBSWY3DPEHPK3PXP",
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

const options = parseRotationArgs([
  "accounts.txt",
  "--output",
  "out.txt",
  "--password-length",
  "32",
  "--skip-verify",
  "--yes",
], "/tmp/codex-acc-test");
assert.equal(options.inputPath, "/tmp/codex-acc-test/accounts.txt");
assert.equal(options.outputPath, "/tmp/codex-acc-test/out.txt");
assert.equal(options.passwordLength, 32);
assert.equal(options.verifyLogin, false);
assert.equal(options.yes, true);

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
console.log("Password rotation tests passed.");
