# switch-codex-accounts

Small local CLI to switch Codex accounts by replacing `~/.codex/auth.json`
with a JSON profile stored in this project.

## Setup

```sh
npm link
```

After linking, the `codex-acc` command is available from this machine.

## Profiles

Put account files in `profiles/`:

```text
profiles/
  personal.json
  work.json
```

Each file should contain the full JSON content you want written to
`~/.codex/auth.json`.

## Commands

```sh
codex-acc list
codex-acc use personal
codex-acc current
codex-acc save new-profile
codex-acc quota
codex-acc quota --json
codex-acc sw
```

`use` validates that the profile is valid JSON, backs up the current
`auth.json` beside it as `auth.json.backup-<timestamp>`, then writes the
selected profile to `~/.codex/auth.json`.

`save` copies the current `~/.codex/auth.json` into `profiles/<name>.json`.
It refuses to overwrite an existing profile.

`quota` checks every `profiles/*.json` file and prints only the remaining 5h
and weekly percentages.

```sh
work               5h [#################---]  84%  week [###################-]  97% <- best 5h
personal           5h [####----------------]  20%  week [########------------]  40%
```

`sw` checks every profile, picks the one with the highest remaining 5h
percentage, then switches `~/.codex/auth.json` to that profile. If every
profile is out of 5h quota, it consumes available reset credits, checks quota
again, and only switches after a profile has quota. If every profile is still
out of quota, it reports that no switch was made.

## Environment

```sh
CODEX_HOME=/path/to/.codex codex-acc use work
CODEX_ACCOUNT_PROFILES=/path/to/profiles codex-acc list
CODEX_ACCOUNT_CODEX_BIN=/path/to/codex codex-acc quota
```
