const assert = require("node:assert/strict");

const {
  normalizeQuotaRows,
  readQuotaSummaries,
} = require("../lib/quota");

(async () => {
  const normalized = normalizeQuotaRows([{
    profile: " work ",
    weekRemainingPercent: 125,
    weekResetsAt: "2030-01-01T00:00:00Z",
    resetCreditsAvailable: 2.8,
    resetCreditsNextExpiry: "2030-01-31T00:00:00Z",
    otherWindows: [{
      durationMins: 43_200,
      remainingPercent: -5,
      resetsAt: "2030-02-01T00:00:00Z",
    }],
  }]);
  assert.deepEqual(normalized, [{
    profile: "work",
    weekRemainingPercent: 100,
    weekResetsAt: "2030-01-01T00:00:00.000Z",
    resetCreditsAvailable: 2,
    resetCreditsNextExpiry: "2030-01-31T00:00:00.000Z",
    otherWindows: [{
      durationMins: 43_200,
      remainingPercent: 0,
      resetsAt: "2030-02-01T00:00:00.000Z",
    }],
    error: null,
  }]);

  let invocation;
  const rows = await readQuotaSummaries({
    execFileImpl(executable, args, options, callback) {
      invocation = { executable, args, options };
      callback(null, JSON.stringify([{
        profile: "acc1",
        weekRemainingPercent: 75,
        resetCreditsAvailable: 1,
        resetCreditsNextExpiry: null,
      }]), "");
    },
  });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args.slice(-2), ["quota", "--json"]);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(rows[0].profile, "acc1");
  assert.equal(rows[0].weekRemainingPercent, 75);

  await assert.rejects(
    readQuotaSummaries({
      execFileImpl(_executable, _args, _options, callback) {
        callback(new Error("exit 1"), "", "quota failed");
      },
    }),
    /Could not read Codex quotas: quota failed/,
  );

  console.log("Quota reader tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
