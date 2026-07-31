# pnpm better-sqlite3 Build Design

## Problem

pnpm 10 blocks dependency lifecycle scripts unless a package is explicitly
approved. As a result, installing this project with pnpm can leave
`better-sqlite3` without its native binding, and `codex-acc dashboard` then
fails during startup.

## Design

Add `better-sqlite3` to `pnpm.onlyBuiltDependencies` in `package.json`. This
keeps pnpm's dependency-build allowlist narrow while permitting the native
module's documented install script to download or compile its binding.

Do not change dashboard runtime logic, npm behavior, database paths, ports, or
authentication. Do not commit the pre-existing untracked `pnpm-lock.yaml`.

## Verification

Add a focused configuration assertion to the existing smoke test so the
required pnpm allowlist entry cannot be removed accidentally. Verify the test
fails before adding the configuration, then passes afterward.

Run the complete check and test suites. Finally, start the dashboard on a local
test port and confirm an authenticated request returns HTTP 200.

## Delivery

Commit the configuration and regression test on
`fix/pnpm-better-sqlite3-build`, push the branch, and open a pull request against
`main`.
