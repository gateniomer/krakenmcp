# KrakenMCP reference

The [README](../README.md) covers what Kraken is and how to start. This page lists everything else:
connecting each client, tools, tentacle fields, the CLI, agent adapters and where data lives.

- [Connect a client](#connect-a-client)
- [Tools](#tools)
- [Run statuses and notifications](#run-statuses-and-notifications)
- [Tentacle fields and settings layers](#tentacle-fields-and-settings-layers)
- [CLI](#cli)
- [Agent adapters](#agent-adapters)
- [Data](#data)

## Connect a client

The server command is `npx -y krakenmcp` (from npm) or `node /path/to/krakenmcp/src/bin.js` (from a
source checkout). The examples use the npm form.

**Claude Code**

```sh
claude mcp add kraken -- npx -y krakenmcp
```

**opencode** (`~/.config/opencode/opencode.json` or a project `opencode.json`)

```json
{ "mcp": { "kraken": { "type": "local", "command": ["npx", "-y", "krakenmcp"], "enabled": true } } }
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.kraken]
command = "npx"
args = ["-y", "krakenmcp"]
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{ "mcpServers": { "kraken": { "command": "npx", "args": ["-y", "krakenmcp"] } } }
```

Any other MCP client that starts stdio servers works the same way.

## Tools

| Tool | What it does |
|---|---|
| `think(problem, …)` | Escalate a hard reasoning problem: analysis, options, recommendation, open questions |
| `plan(task, context_runs?, …)` | File-by-file implementation plan |
| `execute(plan_id, verify?, isolation?, …)` | Implement a plan on a `kraken/<run_id>` branch |
| `review(run_id?, focus?, …)` | Review a run's branch (with its plan) or your uncommitted changes |
| `explain(area, …)` | One-page map of how part of the codebase works |
| `run(tentacle, input?, plan_id?, context_runs?, …)` | Run any tentacle, including your own |
| `pipeline(task, verify?, max_fix_rounds?, …)` | Plan -> execute -> review with fix rounds; stops before merge (unless approval mode is `auto`) |
| `status(run_id, wait_seconds?, full?)` | Progress, result, metrics, verify result. Also takes a pipeline id |
| `resume(run_id, input)` | Answer a `waiting` run's question, or give a finished run a follow-up, in the same agent session and branch |
| `cancel(run_id)` | Stop a queued or running run, or a pipeline |
| `update(run_id, resolve?)` | Merge your current branch into the run's branch; the agent resolves conflicts |
| `merge(run_id, confirm?)` | Preview, then merge a run's branch and clean up |
| `discard(run_id)` | Delete a run's branch and worktree |
| `session(session?)` | What needs you (running, waiting, ready to merge), recent runs and pipelines, totals per tentacle / agent / model |
| `tentacles(cwd?, show_prompts?, check_agents?)` | Resolved settings and where each came from, installed agents (versions with `check_agents`), limits, approval mode |

`think`, `plan`, `execute`, `review`, `explain`, `run` and each `pipeline` stage also accept per-call
`agent`, `model` and `effort` overrides. Stored settings change only through the CLI or tentacle files.

Every start tool takes a `session` label (default `"default"`) that groups runs for `session` and
for session reuse.

## Run statuses and notifications

Run statuses: `queued`, `running`, `done`, `failed`, `verify_failed`, `timeout`, `cancelled`,
`over_budget`, `waiting`, `answered`. Write runs also get an outcome: `merged` or `discarded`.
Pipelines are `running`, `waiting`, `done`, `failed` or `cancelled`.

While `status` waits it sends MCP progress notifications if the client passes a progress token.
When a run or pipeline finishes (or starts waiting for an answer) the server sends a log message
(`logger: "kraken"`).

Resources:

- `kraken://run/<id>`: a run's or pipeline's status as JSON. Subscribers get `resources/updated`.
- `kraken://result/<id>`: a run's full Markdown result (a plan, a review), for clients that let you
  open or @-mention resources.

## Tentacle fields and settings layers

| Field | Meaning |
|---|---|
| `description` | One line shown in `tentacles()` and `krakenmcp list` |
| `access` | `read` (cannot edit) or `write`. Enforced through agent flags plus a fixed preamble; a prompt cannot widen it |
| `agent`, `model`, `effort` | Who runs it. Changing `agent` without a `model` resets the model to that agent's default |
| `prompt` | Template with `{{task}}` `{{plan}}` `{{context}}` `{{diff}}` `{{workdir}}` `{{repo}}` |
| `isolation` | Write tentacles: `worktree` (default) or `none` (edit your checkout in place) |
| `verify` | Command Kraken runs after a write tentacle; non-zero exit means `verify_failed` |
| `timeout_min` | The agent and everything it started are stopped after this |
| `max_cost_usd` | Stop the run (`over_budget`) once its cost passes this. Claude Code also gets `--max-budget-usd` |
| `max_tokens` | Stop the run once input + output + reasoning tokens pass this |
| `reuse_session_min` | Read tentacles: continue the agent session of this tentacle's last run in the same session label if it finished this many minutes ago or less. `explain` defaults to 5; others are off |

A prompt using `{{plan}}` needs `plan_id`; one using `{{diff}}` gets a run's changes or your
uncommitted changes; `context_runs` results go into `{{context}}` (or are appended).

**Layers**, last wins:

1. built-in (`src/tentacles/<name>.md`)
2. your tentacle files (`~/.kraken/tentacles/<name>.md`)
3. global settings (`krakenmcp set … --global`)
4. the repo's files (`.kraken/tentacles/<name>.md`, `.kraken/tentacles.json`), once trusted
5. repo settings (`krakenmcp set …` inside the repo)
6. the call's `agent` / `model` / `effort`

`tentacles()` shows every value and which layer it came from. Every stored change is logged
(`krakenmcp log`).

**Tentacle file format.** A `---` header of `key: value` lines (values are parsed as JSON when
possible: `null`, numbers, `true`/`false`; otherwise kept as text), a closing `---`, then the
prompt. Lines starting with `#` in the header are comments. The file name is the tentacle name:
lowercase letters, digits, `-` or `_`, up to 32 characters.

**Budgets.** Agents report different metrics: Codex and Cursor report no cost, and Cursor reports
no tokens either. A limit on a metric the agent does not report cannot be enforced; the start tool
says so in `warnings`, and `status` / `session` mark those metrics as `not_reported`.

## CLI

```sh
krakenmcp                      # start the MCP server (what MCP clients run)
krakenmcp about                # overview with an ASCII kraken (colored in a terminal)
krakenmcp doctor               # installed agents and versions; exits 1 if a tentacle needs a missing one
krakenmcp show [run_id]        # a run's full result (default: the newest); --open in $VISUAL/$EDITOR, --log raw output
krakenmcp list                 # resolved tentacles for the current repo
krakenmcp set <name> key=value ... [--global] [--cwd <repo>]
krakenmcp unset <name> key ... [--global]
krakenmcp reset <name>         [--global]
krakenmcp mode [ask|auto]      # show / set the approval mode (default ask)
krakenmcp limit [n]            # show / set how many runs may work at once (default 3)
krakenmcp budget [usd|off]     # show / set the daily spend limit across all runs
krakenmcp export [name ...] [--global] [--out file]   # stored tentacle settings as JSON
krakenmcp import <file> [--global]                    # load an export
krakenmcp trust | untrust      # use / stop using this repo's .kraken/tentacles.json and .kraken/tentacles/*.md
krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
krakenmcp log                  # config change history
```

From a source checkout, run `node src/bin.js …` instead of `krakenmcp …`.

`set` values are parsed as JSON when possible (`null`, numbers, booleans), otherwise as strings.

`prune` deletes log and result files and stored prompts of runs that finished more than N days ago
(run history and stats are kept), and lists branches that were never merged. With `--worktrees` it
also discards those older than N days. Use `--dry-run` first.

## Agent adapters

One file per agent in [`src/agents/`](../src/agents); the contract is at the top of
[`src/agents.js`](../src/agents.js).

| Agent | Status | Read mode | Write mode | Effort | Resume |
|---|---|---|---|---|---|
| opencode | run against v2.2.5 | `run --agent plan` | `run --auto` | `-m provider/model#<effort>` | `--session <id>` |
| claude | docs-checked, not run | `-p --permission-mode plan` | `--permission-mode acceptEdits` | `--effort <level>` | `--resume <id>` |
| codex | docs-checked, not run | `exec --sandbox read-only` | `--sandbox workspace-write` | `-c model_reasoning_effort=…` | `exec … resume <id>` |
| cursor | docs-checked, not run | `-p --mode ask --trust` | `-p --force --trust` | not supported | `--resume <chatId>` |
| aider | docs-checked, not run | `--message … --chat-mode ask` | `--message … --yes-always --no-auto-commits` | `--reasoning-effort` | `--restore-chat-history` |

Not yet confirmed for Codex: whether `exec` options must come before `resume` (Kraken puts them
first). Claude Code runs with `--output-format stream-json --verbose`, so tool calls are counted and
usage is read while it runs. Codex reports no cost; Cursor reports no token counts or cost. Aider
prints plain text: Kraken reads tokens and cost from its `Tokens: … Cost: …` lines, keeps its chat
history in `~/.kraken/logs` (outside the worktree) and never commits `.aider*` files. Gemini CLI is
not supported: it was replaced by Antigravity CLI in June 2026. Kraken looks for `cursor-agent`
before the generic `agent` binary name, and never passes Cursor's `--approve-mcps`.

## Data

Everything lives in `~/.kraken` (override with `KRAKEN_DATA`):

- `kraken.db`: runs, messages, tentacle settings and config changes (SQLite, WAL mode)
- `plans/<run_id>.md`: results of read tentacles (`krakenmcp show <run_id>` prints one)
- `tentacles/<name>.md`: your own tentacles
- `logs/<run_id>.log`: full raw agent output (`krakenmcp show <run_id> --log`)
- `worktrees/<run_id>/`: write runs' worktrees (removed by `merge`, `discard` or `prune --worktrees`)
