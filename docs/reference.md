# KrakenMCP reference

The [README](../README.md) covers what Kraken is and how to start. This page lists everything else:
connecting each client, tools, tentacle fields, the CLI, agent adapters and where data lives.

- [Connect a client](#connect-a-client)
- [Tools](#tools)
- [Run statuses and progress](#run-statuses-and-progress)
- [Tentacle fields and settings layers](#tentacle-fields-and-settings-layers)
- [CLI](#cli)
- [Agent adapters](#agent-adapters)
- [Data](#data)

## Connect a client

The server command is `krakenmcp` (after `npm install -g github:gateniomer/kraken`) or
`node /path/to/kraken/src/bin.js` (from a source checkout). The examples use `krakenmcp`.

**Claude Code**

```sh
claude mcp add kraken -- krakenmcp
```

**OpenCode** (`~/.config/opencode/opencode.json` or a project `opencode.json`)

```json
{ "mcp": { "kraken": { "type": "local", "command": ["krakenmcp"], "enabled": true } } }
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.kraken]
command = "krakenmcp"
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{ "mcpServers": { "kraken": { "command": "krakenmcp" } } }
```

Any other MCP client that starts stdio servers works the same way.

## Tools

| Tool | What it does |
|---|---|
| `think(problem, …)` | Escalate a hard reasoning problem: analysis, options, recommendation, open questions |
| `plan(task, context_runs?, …)` | File-by-file implementation plan |
| `execute(plan_id, verify?, …)` | Implement a plan on a `kraken/<run_id>` branch |
| `review(run_id?, focus?, …)` | Review a run's branch (with its plan) or your uncommitted changes |
| `explain(area, …)` | One-page map of how part of the codebase works |
| `run(tentacle, input?, plan_id?, context_runs?, …)` | Run any tentacle, including your own |
| `pipeline(task, verify?, max_fix_rounds?, …)` | Plan -> execute -> review with fix rounds; stops before merge (unless approval mode is `auto`) |
| `status(run_id, wait_seconds?, full?, since?)` | Progress, result, metrics, verify result. Also takes a pipeline id. With `since`, returns the live `feed` (see below) |
| `resume(run_id, input)` | Answer a `waiting` run's question, or give a finished run a follow-up, in the same agent session and branch |
| `cancel(run_id)` | Stop a queued or running run, or a pipeline |
| `update(run_id, resolve?)` | Merge your current branch into the run's branch; the agent resolves conflicts |
| `merge(run_id, confirm?)` | Preview, then merge a run's branch and clean up |
| `discard(run_id)` | Delete a run's branch and worktree |
| `session(session?)` | What needs you (running, waiting, ready to merge), recent runs and pipelines, totals per tentacle / agent / model |
| `tentacles(cwd?, show_prompts?, check_agents?)` | Resolved settings and where each came from, installed agents (versions with `check_agents`), limits, approval mode |

`think`, `plan`, `execute`, `review`, `explain`, `run` and each `pipeline` stage also accept per-call
`agent`, `model` and `effort` overrides. Stored settings change only through your tentacle files.

Every start tool takes a `session` label (default `"default"`) that groups runs for `session`.

## Run statuses and progress

Run statuses: `queued`, `running`, `done`, `failed`, `verify_failed`, `timeout`, `cancelled`,
`over_budget`, `waiting`, `answered`. Write runs also get an outcome: `merged` or `discarded`.
Pipelines are `running`, `waiting`, `done`, `failed` or `cancelled`.

While `status` waits it sends MCP progress notifications if the client passes a progress token.

A `failed`, `timeout` or `over_budget` run, or a `failed` pipeline, returns a `next` that tells the head
to stop: it reports the error to the developer and does not retry on another agent or model on its own.

### Live feed

`status` takes `since`, a cursor (a message id; start with `0`). It returns:

- `summary`: the live state, so the head can show where the tentacle is at above the feed. It is returned in
  every reply, in progress or finished. `headline` is a ready-made one-liner
  (`[ 🦑 plan › claude opus ]  ● running  42s    6 tools   using read`); `kind` is `run` or `pipeline`;
  `tools` is a count and per-name breakdown; `last_line` is the agent's own latest text; `question` is set
  while waiting; plus `status`, `elapsed_s`, `cost_usd` and `stage` (pipelines only). `milestones` has
  `plan_id` / `verify` / `resumed_from` for a run and `plan_done` / `execute_done` / `review_done` /
  `verify` / `fix_rounds` for a pipeline (`verify` is `{ cmd, exit }` in both). The head writes one or two
  human lines from it (`So far: …`, `Now: …`) and shows `headline` as it is.
- `feed`: ready-made lines for the progress made after `since`, which the head shows to the developer as
  they are, e.g. `plan tentacle (claude opus): "Reading src/server.js…"`. Tool calls are folded into one
  line (`  · tools: Read ×3, Grep`). Text is cut at 200 characters. At most 12 lines per reply; older ones
  are replaced by `(+N earlier lines; full log: krakenmcp show <id>)`. In a pipeline the stage comes first
  (`review › review tentacle (…)`) and one cursor covers every run.
- `cursor`: pass it as `since` on the next call so no line repeats or is lost. `describe` output also
  carries `cursor`.

While the run or pipeline is in progress and `since` is given, the reply is compact: `id`, `status`,
`stage` (pipelines), `elapsed_s`, `cost_usd`, `summary`, `feed`, `cursor`, `next`. Once it ends (or is `waiting` on a
question) the reply is the full one plus the last `feed` and `cursor`. Every reply carries `summary`; without `since`
the reply is otherwise unchanged apart from `cursor`; run and pipeline replies both carry one, so following can start
at any time. Codex runs only show lifecycle lines.

## Tentacle fields and settings layers

| Field | Meaning |
|---|---|
| `description` | One line shown in `tentacles()` and `krakenmcp list` |
| `access` | `read` (cannot edit) or `write`. Enforced through agent flags plus a fixed preamble; a prompt cannot widen it |
| `agent`, `model`, `effort` | Who runs it. Changing `agent` without a `model` resets the model to that agent's default |
| `prompt` | Template with `{{task}}` `{{plan}}` `{{context}}` `{{diff}}` `{{workdir}}` `{{repo}}` |
| `verify` | Command Kraken runs after a write tentacle; non-zero exit means `verify_failed` |
| `timeout_min` | The agent and everything it started are stopped after this |
| `max_cost_usd` | Stop the run (`over_budget`) once its cost passes this. Claude Code also gets `--max-budget-usd` |
| `max_tokens` | Stop the run once input + output + reasoning tokens pass this |

A prompt using `{{plan}}` needs `plan_id`; one using `{{diff}}` gets a run's changes or your
uncommitted changes; `context_runs` results go into `{{context}}` (or are appended).

**Layers**, last wins:

1. built-in (`src/tentacles/<name>.md`)
2. your tentacle files (`~/.kraken/tentacles/<name>.md`): a new tentacle, or just the fields to change
3. the call's `agent` / `model` / `effort`

`tentacles()` shows every value and which layer it came from.

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
krakenmcp doctor               # installed agents and versions; exits 1 if a tentacle needs a missing one
krakenmcp show [run_id]        # a run's full result (default: the newest); --open in $VISUAL/$EDITOR, --log raw output
krakenmcp list                 # resolved tentacles for the current repo
krakenmcp edit <name>          # open ~/.kraken/tentacles/<name>.md in $VISUAL/$EDITOR (created if missing), then check it
krakenmcp remove <name>        # delete that file: your tentacle is gone, a built-in is back to its defaults
krakenmcp mode [ask|auto]      # show / set the approval mode (default ask)
krakenmcp limit [n]            # show / set how many runs may work at once (default 3)
krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
```

From a source checkout, run `node src/bin.js …` instead of `krakenmcp …`.

`prune` deletes log and result files and stored prompts of runs that finished more than N days ago
(run history and stats are kept), and lists branches that were never merged. With `--worktrees` it
also discards those older than N days. Use `--dry-run` first.

## Agent adapters

One file per agent in [`src/agents/`](../src/agents); the contract is at the top of
[`src/agents.js`](../src/agents.js).

| Agent | Status | Read mode | Write mode | Effort | Resume |
|---|---|---|---|---|---|
| opencode | tested (v2.2.5) | `run --standalone --agent plan` | `run --standalone --auto` | `-m provider/model#<effort>` | `--session <id>` |
| claude | tested | `-p --permission-mode plan` | `--permission-mode acceptEdits` | `--effort <level>` | `--resume <id>` |
| codex | untested | `exec --sandbox read-only` | `--sandbox workspace-write` | `-c model_reasoning_effort=…` | `exec … resume <id>` |
| cursor | untested | `-p --mode ask --trust` | `-p --force --trust` | not supported | `--resume <chatId>` |
| aider | untested | `--message … --chat-mode ask` | `--message … --yes-always --no-auto-commits` | `--reasoning-effort` | `--restore-chat-history` |

OpenCode runs use `--standalone`, so each run gets a private server and never depends on, or collides
with, the developer's background `opencode serve --service`. Not yet confirmed for Codex: whether
`exec` options must come before `resume` (Kraken puts them first). Claude Code runs with
`--output-format stream-json --verbose`, so tool calls are counted and
usage is read while it runs. Codex reports no cost; Cursor reports no token counts or cost. Aider
prints plain text: Kraken reads tokens and cost from its `Tokens: … Cost: …` lines, keeps its chat
history in `~/.kraken/logs` (outside the worktree) and never commits `.aider*` files. Gemini CLI is
not supported: it was replaced by Antigravity CLI in June 2026. Kraken looks for `cursor-agent`
before the generic `agent` binary name, and never passes Cursor's `--approve-mcps`.

## Data

Everything lives in `~/.kraken` (override with `KRAKEN_DATA`):

- `kraken.db`: runs, messages, and the limit / budget / mode settings (SQLite, WAL mode)
- `plans/<run_id>.md`: results of read tentacles (`krakenmcp show <run_id>` prints one)
- `tentacles/<name>.md`: your own tentacles and changes to the built-ins
- `logs/<run_id>.log`: full raw agent output (`krakenmcp show <run_id> --log`)
- `worktrees/<run_id>/`: write runs' worktrees (removed by `merge`, `discard` or `prune --worktrees`)
