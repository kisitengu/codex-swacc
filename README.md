# Switch Codex Accounts

A lightweight CLI for managing and switching between multiple Codex accounts
by updating `~/.codex/auth.json`. It can also check account quotas, select the
profile with the most remaining quota, and rotate passwords for a private local
account list.

> [!CAUTION]
> Profile files contain authentication credentials. Never commit, share, or
> upload them.
>
> Password-rotation input and output files also contain passwords and MFA
> secrets. Keep them local, restrict access to them, and delete them securely
> when they are no longer needed.

## Requirements

- Node.js 18 or later
- Codex CLI installed and available through the `codex` command
- Google Chrome for password rotation (Edge/Chromium can be selected through an
  environment variable)

## Installation

Install from npm:

```sh
npm install --global switch-codex-accounts
```

Verify the installation:

```sh
codex-acc --help
```

You can also install the latest version directly from GitHub:

```sh
npm install --global github:kisitengu/codex-swacc
```

To uninstall:

```sh
npm uninstall --global switch-codex-accounts
```

## Quick start

Profiles are stored in `~/.codex/profiles` by default.

Add an account through the browser-based Codex login flow:

```sh
codex-acc add personal
```

After a successful login, the credentials are automatically saved to
`~/.codex/profiles/personal.json`. Your currently active Codex account remains
unchanged.

Add more accounts in the same way:

```sh
codex-acc add work
```

List and switch between profiles:

```sh
codex-acc list
codex-acc use personal
codex-acc current
```

Your profile directory will look like this:

```text
~/.codex/profiles/
├── personal.json
└── work.json
```

Each profile is a valid JSON file containing the same type of credentials as
`~/.codex/auth.json`.

## Commands

| Command | Description |
| --- | --- |
| `codex-acc list` | List saved profiles |
| `codex-acc current` | Show the currently active profile |
| `codex-acc use <profile>` | Switch to a saved profile |
| `codex-acc add <profile>` | Log in and save a new profile automatically |
| `codex-acc save <profile>` | Save the currently active account as a new profile |
| `codex-acc quota` | Check the quota of every profile |
| `codex-acc quota --json` | Print quota information as JSON |
| `codex-acc sw` | Switch to the profile with the most remaining quota |
| `codex-acc rotate-passwords <file>` | Rotate passwords from a local `email|password|MFA-secret` list |
| `codex-acc dashboard` | Open a local web dashboard backed by a private SQLite database |
| `codex-acc dashboard <file>` | Open the dashboard with an existing text account list |

For headless systems or when the browser callback is unavailable, use device
authentication:

```sh
codex-acc add server-account --device-auth
```

`login` is an alias for `add`:

```sh
codex-acc login personal
```

When you run `use`, the CLI:

1. Validates that the selected profile contains valid JSON.
2. Backs up the current credentials to
   `~/.codex/auth.json.backup-<timestamp>`.
3. Writes the selected profile to `~/.codex/auth.json` with private file
   permissions.
4. On macOS or native Windows, gracefully restarts Codex App when it is already
   running so the new account is loaded immediately.

The restart is enabled by default for both `use` and `sw`. To switch the auth
file without restarting Codex App:

```sh
CODEX_ACCOUNT_RESTART_APP=0 codex-acc use work
```

Running tasks in Codex App are interrupted by the restart. The app is reopened
automatically after it exits.

## Quota-aware switching

Check the remaining quota for every profile:

```sh
codex-acc quota
```

The weekly quota is shown when Codex exposes it. Other active windows are shown
with their actual duration, such as `30d 86%`. The discontinued five-hour
window is intentionally omitted.

Each profile also shows how many reset credits are currently available and the
nearest reset-credit expiration time, for example
`resets 2 (next expires 2026-07-26 12:00 UTC)`. This is the current reset-credit
inventory returned by Codex; it is not assumed to be a fixed monthly allowance.

Slow operations show a spinner in interactive terminals. The spinner is written
to stderr and is automatically disabled when output is redirected, so
`codex-acc quota --json` remains safe for scripts.

Example output:

```text
work       week [###################-]  97% <- best week
           resets 2 (next expires 2026-07-26 12:00 UTC)
personal   week [########------------]  40%
           resets 1 (next expires 2026-07-28 12:00 UTC)
```

Automatically switch to the profile with the most remaining weekly quota:

```sh
codex-acc sw
```

If weekly quota is unavailable, `sw` uses another active window, such as `30d`.
If every profile has exhausted the selected window, the CLI attempts to use
available reset credits, checks the quotas again, and switches only when a
usable profile is available.

## Password rotation

Password rotation is intended only for OpenAI accounts you own or are
authorized to administer. It signs in through the normal ChatGPT web UI, opens
**Settings → Account**, updates the password, and verifies the new password
with a fresh login.

Create a private text file with one account per line:

```text
first@example.com|current-password|BASE32-MFA-SECRET
second@example.com|current-password|BASE32-MFA-SECRET
```

Use `-` instead of the MFA secret only when an account does not have MFA:

```text
without-mfa@example.com|current-password|-
```

Validate the list without opening a browser:

```sh
codex-acc rotate-passwords ./accounts.txt --dry-run
```

Start the rotation:

```sh
codex-acc rotate-passwords ./accounts.txt
```

The command asks for explicit confirmation, opens a visible Chrome window, and
processes accounts sequentially. Each account receives a unique random
24-character password. The updated list is written to
`accounts.rotated.txt`, and progress is checkpointed in
`accounts.rotated.txt.state.json`. Both files use private file permissions
where the operating system supports them.

Useful options:

```sh
# Choose the output file and password length.
codex-acc rotate-passwords ./accounts.txt \
  --output ./accounts-new.txt \
  --password-length 32

# Resume after an interruption without reprocessing successful accounts.
codex-acc rotate-passwords ./accounts.txt \
  --output ./accounts-new.txt \
  --resume

# Continue after failures that occur before the final password form is sent.
codex-acc rotate-passwords ./accounts.txt --continue-on-error
```

The CLI stops when a failure happens after the final password form is
submitted, because the account may already have the new password. In that
case, keep the new password from the rotated output and verify the account
manually before resuming. CAPTCHA, push approval, or unusual email verification
may require manual interaction in the visible browser. Headless mode cannot
complete those challenges.

Accounts created through Google, Microsoft, Apple, or enterprise SSO may not
have an OpenAI password to rotate. The command is designed for accounts that
sign in with an email address and password.

## Local dashboard

Open the local dashboard. By default, accounts are stored in the private SQLite
database at `~/.codex/accounts.sqlite3`:

```sh
codex-acc dashboard
```

To manage an existing text account list instead:

```sh
codex-acc dashboard ./accounts.txt
```

The server binds only to `127.0.0.1`, generates a random session token, and
opens the dashboard in your default browser. The dashboard can add, edit, and
delete accounts, and can start the same sequential password rotation flow used
by `rotate-passwords`. Passwords and MFA secrets are fully masked in API
responses and in the page. SQLite is the recommended storage; text-file mode is
kept for compatibility and updates the underlying file with private permissions.

To add many accounts at once, paste them into **Import multiple accounts**, one
account per line using `email|password|MFA-secret`. The whole batch is validated
before it is saved. If any line is invalid or an email already exists, no account
from that batch is imported.

Useful options:

```sh
# Pick a fixed local port.
codex-acc dashboard --port 8787

# Pick a different SQLite database.
codex-acc dashboard --db ./accounts.sqlite3

# Start without opening a browser (useful for tests).
codex-acc dashboard --no-open
```

Keep the terminal process running while using the dashboard. Press `Ctrl-C` to
stop it. Do not bind this server to `0.0.0.0` or expose the generated URL to
other people.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex configuration directory |
| `CODEX_ACCOUNT_PROFILES` | `~/.codex/profiles` | Profile storage directory |
| `CODEX_ACCOUNT_CODEX_BIN` | `codex` | Path to the Codex CLI executable |
| `CODEX_ACCOUNT_QUOTA_CONCURRENCY` | `5` | Maximum number of parallel quota checks (capped at 32) |
| `CODEX_ACCOUNT_RESTART_APP` | `1` | Set to `0` to disable automatic Codex App restart on macOS or Windows |
| `CODEX_ACCOUNT_BROWSER_CHANNEL` | `chrome` | Playwright browser channel used for password rotation |
| `CODEX_ACCOUNT_BROWSER_EXECUTABLE` | unset | Full path to Chrome, Edge, or Chromium |

Examples:

```sh
CODEX_HOME=/path/to/.codex codex-acc use work
CODEX_ACCOUNT_PROFILES=/path/to/profiles codex-acc list
CODEX_ACCOUNT_CODEX_BIN=/path/to/codex codex-acc quota
CODEX_ACCOUNT_QUOTA_CONCURRENCY=6 codex-acc quota
CODEX_ACCOUNT_RESTART_APP=0 codex-acc use work
CODEX_ACCOUNT_BROWSER_CHANNEL=msedge codex-acc rotate-passwords ./accounts.txt
```

### Windows notes

On Windows, the default Codex directory is:

```text
%USERPROFILE%\.codex
```

Profiles are stored in:

```text
%USERPROFILE%\.codex\profiles
```

PowerShell examples:

```powershell
codex-acc add personal
codex-acc list
codex-acc use personal

$env:CODEX_HOME = "$HOME\.codex"
$env:CODEX_ACCOUNT_PROFILES = "$HOME\.codex\profiles"
$env:CODEX_ACCOUNT_CODEX_BIN = "codex.cmd"
codex-acc quota

$env:CODEX_ACCOUNT_BROWSER_CHANNEL = "msedge"
codex-acc rotate-passwords .\accounts.txt
```

Command Prompt examples:

```bat
codex-acc add personal
codex-acc list
codex-acc use personal

set CODEX_HOME=%USERPROFILE%\.codex
set CODEX_ACCOUNT_PROFILES=%USERPROFILE%\.codex\profiles
set CODEX_ACCOUNT_CODEX_BIN=codex.cmd
codex-acc quota
```

If Windows cannot find the Codex executable, locate it with:

```powershell
where.exe codex
```

Then set `CODEX_ACCOUNT_CODEX_BIN` to the returned `codex.cmd` path.

On native Windows, `use` and `sw` detect the desktop process through PowerShell,
close its main window, and reopen it with the stable `codex app` command. This
avoids stopping terminal-only Codex CLI processes. Automatic app restart is not
available when `codex-acc` runs inside WSL; run the command from PowerShell or
Command Prompt instead.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and upgrade details.

## Development

```sh
git clone https://github.com/kisitengu/codex-swacc.git
cd codex-swacc
npm install
npm run check
npm test
npm run test:browser
npm link
```

## License

UNLICENSED — for internal use only.
