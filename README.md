# Switch Codex Accounts

A lightweight CLI for managing and switching between multiple Codex accounts
by updating `~/.codex/auth.json`. It can also check account quotas and
automatically switch to the profile with the most remaining five-hour quota.

> [!CAUTION]
> Profile files contain authentication credentials. Never commit, share, or
> upload them.

## Requirements

- Node.js 18 or later
- Codex CLI installed and available through the `codex` command

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

## Quota-aware switching

Check the remaining quota for every profile:

```sh
codex-acc quota
```

Example output:

```text
work       5h [#################---]  84%  week [###################-]  97% <- best 5h
personal   5h [####----------------]  20%  week [########------------]  40%
```

Automatically switch to the profile with the most remaining five-hour quota:

```sh
codex-acc sw
```

If every profile has exhausted its five-hour quota, the CLI attempts to use
available reset credits, checks the quotas again, and switches only when a
usable profile is available.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex configuration directory |
| `CODEX_ACCOUNT_PROFILES` | `~/.codex/profiles` | Profile storage directory |
| `CODEX_ACCOUNT_CODEX_BIN` | `codex` | Path to the Codex CLI executable |

Examples:

```sh
CODEX_HOME=/path/to/.codex codex-acc use work
CODEX_ACCOUNT_PROFILES=/path/to/profiles codex-acc list
CODEX_ACCOUNT_CODEX_BIN=/path/to/codex codex-acc quota
```

## Development

```sh
git clone https://github.com/kisitengu/codex-swacc.git
cd codex-swacc
npm install
npm run check
npm test
npm link
```

## License

UNLICENSED — for internal use only.
