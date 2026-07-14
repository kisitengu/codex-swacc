# Changelog

All notable changes to `switch-codex-accounts` are documented in this file.

## [Unreleased]

### Added

- Show the number of available quota reset credits for every profile.
- Show the nearest reset-credit expiration time in human and JSON quota output.

### Changed

- Select and refresh profiles by weekly quota, falling back to another active
  quota window such as `30d` when weekly quota is unavailable.
- Simplify `sw` output to show only the quota window used for selection.

### Removed

- Remove the discontinued five-hour quota from human and JSON output.

## [1.3.0] - 2026-07-13

### Added

- Added an animated loading indicator for quota checks, quota refreshes, and
  Codex App status checks. The spinner uses stderr and stays out of JSON output.
- Added `CODEX_ACCOUNT_QUOTA_CONCURRENCY` to control parallel quota checks. It
  defaults to `5` and is capped at `32`.
- Added duration-aware quota output for non-standard windows such as `30d`.

### Changed

- Run quota checks and reset-credit consumption concurrently while preserving
  deterministic profile ordering.
- Request only `account/rateLimits/read`; the unused `account/usage/read`
  request is no longer made.
- After consuming reset credits, recheck only profiles that were refreshed
  instead of scanning every profile again.
- Select the best account by the five-hour window when available, otherwise
  fall back to the weekly window and label the selection explicitly.

### Fixed

- Detect five-hour and weekly limits from `windowDurationMins` instead of
  assuming `primary` always means five hours and `secondary` always means one
  week.
- Avoid showing weekly or 30-day quota as five-hour quota when Codex returns a
  single active rate-limit window.
- Keep `quota --json` machine-readable while progress is displayed in an
  interactive terminal.

## [1.2.0] - 2026-07-10

### Added

- Automatically restart Codex App after `use` or `sw` on macOS and native
  Windows when the app is already running.
- Added `CODEX_ACCOUNT_RESTART_APP=0` to disable automatic app restart.
- Added native Windows support for npm `.cmd` shims and Codex process handling.

### Changed

- Centralized Codex process spawning for consistent macOS, Linux, and Windows
  behavior.

## [1.1.1] - 2026-07-09

### Fixed

- Normalized the npm binary path and improved global installation reliability.

## [1.1.0] - 2026-07-09

### Added

- Added `codex-acc add <profile>` and `codex-acc login <profile>` for creating
  profiles through the Codex login flow.
- Added device-auth support for headless environments.

## [1.0.0] - 2026-07-09

### Added

- Initial `codex-acc` CLI release with profile listing, saving, switching,
  quota inspection, and quota-aware automatic account selection.
