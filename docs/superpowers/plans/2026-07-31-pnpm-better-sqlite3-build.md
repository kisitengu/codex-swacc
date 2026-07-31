# pnpm better-sqlite3 Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure pnpm 10 builds the native `better-sqlite3` binding required by `codex-acc dashboard`.

**Architecture:** Keep the fix in package-manager metadata rather than changing dashboard runtime behavior. A smoke-test assertion protects the narrow pnpm build allowlist from accidental removal.

**Tech Stack:** Node.js 18+, npm test runner scripts, pnpm 10 package metadata, better-sqlite3.

---

### Task 1: Protect the pnpm native-build allowlist

**Files:**
- Modify: `test/smoke.test.js:314`
- Modify: `package.json:34`

- [ ] **Step 1: Write the failing test**

Add the following assertion immediately after the existing `packageJson.bin`
assertion in `test/smoke.test.js`:

```js
assert.deepEqual(packageJson.pnpm?.onlyBuiltDependencies, [
  "better-sqlite3",
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node ./test/smoke.test.js
```

Expected: FAIL with an assertion showing the actual value is `undefined` and
the expected value is `["better-sqlite3"]`.

- [ ] **Step 3: Add the minimal package configuration**

Add this top-level object between `scripts` and `dependencies` in
`package.json`:

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "better-sqlite3"
  ]
},
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node ./test/smoke.test.js
```

Expected: exit code 0 and `smoke test passed`.

- [ ] **Step 5: Run complete static and test verification**

Run:

```bash
npm run check
npm test
```

Expected: both commands exit 0; the test command reports each suite as passed.

- [ ] **Step 6: Verify the dashboard startup behavior**

Start the real dashboard server on an unused local port, make an authenticated
request with its generated token, and close it cleanly:

```bash
node -e 'const os=require("node:os");const path=require("node:path");const {startDashboard}=require("./lib/dashboard");(async()=>{const dbPath=path.join(os.tmpdir(),`codex-swacc-dashboard-${process.pid}.sqlite3`);const dashboard=await startDashboard({dbPath,port:2002,open:false});const response=await fetch(dashboard.url);console.log(response.status);await dashboard.close()})().catch((error)=>{console.error(error);process.exitCode=1})'
```

Expected: the command prints the tokenized dashboard URL, then `200`, and exits
with code 0.

- [ ] **Step 7: Review GitNexus change scope**

Run `gitnexus_detect_changes` with repository `codex-swacc` and scope `all`.
Expected: only package metadata and the intended smoke-test assertion are
reported, with no unexpected execution flows.

- [ ] **Step 8: Commit the implementation**

Stage only the plan, smoke test, and package metadata; leave the pre-existing
untracked `pnpm-lock.yaml` untouched:

```bash
git add docs/superpowers/plans/2026-07-31-pnpm-better-sqlite3-build.md \
  test/smoke.test.js package.json
git commit -m "fix: allow pnpm to build better-sqlite3"
```

### Task 2: Review and deliver

**Files:**
- Review: all changes from `main..fix/pnpm-better-sqlite3-build`

- [ ] **Step 1: Review the complete branch diff**

Run:

```bash
git diff --check
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: no whitespace errors and no files outside the design, plan, smoke
test, and package metadata.

- [ ] **Step 2: Push the feature branch**

Run:

```bash
git push -u origin fix/pnpm-better-sqlite3-build
```

Expected: the remote branch is created and local upstream tracking is set.

- [ ] **Step 3: Create the pull request**

Create a GitHub pull request targeting `main` with:

```text
Title: fix: allow pnpm to build better-sqlite3

Summary:
- allow pnpm 10 to run the better-sqlite3 native install script
- add a smoke-test assertion protecting the allowlist
- document the narrowly scoped design and implementation plan

Test plan:
- npm run check
- npm test
- dashboard startup and authenticated HTTP 200 on a local test port
```

Expected: GitHub returns a pull-request URL.
