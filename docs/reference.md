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
| `chain(name?, task, verify?, max_fix_rounds?, context_runs?, cwd?, overrides?, session?)` | Run a chain of stages (default: plan -> execute -> review with fix rounds); pauses where a stage's autonomy is `ask` |
| `status(run_id, wait_seconds?, full?, since?)` | Progress, result, metrics, verify result. Also takes a chain id. With `since`, returns the live `feed` (see below) |
| `resume(run_id, input)` | Answer a `waiting` run's question, give a finished run a follow-up (same agent session and branch), or answer a paused chain |
| `cancel(run_id)` | Stop a queued or running run, or a chain (also a paused one) |
| `update(run_id, resolve?)` | Merge your current branch into the run's branch; the agent resolves conflicts |
| `merge(run_id, confirm?)` | Preview, then merge a run's branch and clean up |
| `discard(run_id)` | Delete a run's branch and worktree |
| `session(session?)` | What needs you (running, waiting, ready to merge), recent runs and chains, totals per tentacle / agent / model |
| `tentacles(cwd?, show_prompts?, check_agents?)` | Resolved settings and where each came from, chains, installed agents (versions with `check_agents`), limits |

`think`, `plan`, `execute`, `review`, `explain` and `run` also accept per-call `agent`, `model` and
`effort` overrides; `chain` takes them per stage as `overrides: [{ stage: "<tentacle>", agent?, model?,
effort? }]` (a stage the chain does not have is an error). Stored settings change only through your
tentacle and chain files.

Every start tool takes a `session` label (default `"default"`) that groups runs for `session`.

## Run statuses and progress

Run statuses: `queued`, `running`, `done`, `failed`, `verify_failed`, `timeout`, `cancelled`,
`over_budget`, `waiting`, `answered`. Write runs also get an outcome: `merged` or `discarded`.
Chains are `running`, `waiting`, `done`, `failed` or `cancelled`. A `waiting` chain either waits on
a stage's question (answer the stage run) or is paused, with `pause: { reason, after, next_stage }`:
`approval` after a stage whose autonomy is `ask`, or `verify_failed` when verify failed with no fix
rounds left. `resume(chain_id, reply)` continues a paused chain.

While `status` waits it sends MCP progress notifications if the client passes a progress token.

Every finished run and chain returns a `next`, the one step after it:

- `ask: …` show the result, suggest exactly that step, then wait for the developer.
- `auto: …` the tentacle's autonomy is `auto`: the head may take the step without asking.
- `stop: …` report to the developer and wait. A `failed`, `timeout` or `over_budget` run, or a
  `failed` chain, gets this; the head does not retry on another agent or model on its own.

Questions, failures and `verify_failed` never depend on autonomy. A run that belongs to a chain
points to the chain's status instead.

### Live feed

`status` takes `since`, a cursor (a message id; start with `0`). It returns:

- `summary`: the live state, so the head can show where the tentacle is at above the feed. It is returned in
  every reply, in progress or finished. `headline` is a ready-made one-liner
  (`[ 🦑 plan › claude opus ]  ● running  42s    6 tools   using read`); `kind` is `run` or `chain`;
  `tools` is a count and per-name breakdown; `last_line` is the agent's own latest text; `question` is set
  while waiting; plus `status`, `elapsed_s`, `cost_usd` and `stage` (chains only). `milestones` has
  `plan_id` / `verify` / `resumed_from` for a run and `stages` (`"2 of 3"`) / `verify` / `fix_rounds`
  for a chain (`verify` is `{ cmd, exit }` in both). The head writes one or two
  human lines from it (`So far: …`, `Now: …`) and shows `headline` as it is.
- `feed`: ready-made lines for the progress made after `since`, which the head shows to the developer as
  they are, e.g. `plan tentacle (claude opus): "Reading src/server.js…"`. Tool calls are folded into one
  line (`  · tools: Read ×3, Grep`). Text is cut at 200 characters. At most 12 lines per reply; older ones
  are replaced by `(+N earlier lines; full log: krakenmcp show <id>)`. In a chain the stage comes first
  (`review › review tentacle (…)`) and one cursor covers every run.
- `cursor`: pass it as `since` on the next call so no line repeats or is lost. `describe` output also
  carries `cursor`.

While the run or chain is in progress and `since` is given, the reply is compact: `id`, `status`,
`stage` (chains), `elapsed_s`, `cost_usd`, `summary`, `feed`, `cursor`, `next`. Once it ends (or is `waiting` on a
question) the reply is the full one plus the last `feed` and `cursor`. Every reply carries `summary`; without `since`
the reply is otherwise unchanged apart from `cursor`; run and chain replies both carry one, so following can start
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
| `autonomy` | `ask` (default) or `auto`: the step after a successful run. `ask` = the head suggests it and waits; `auto` = the head or a chain takes it. The review tentacle's autonomy decides merging |

A prompt using `{{plan}}` needs `plan_id`; one using `{{diff}}` gets a run's changes or your
uncommitted changes; `context_runs` results go into `{{context}}` (or are appended).

**Layers**, last wins:

1. built-in (`src/tentacles/<name>.md`)
2. your tentacle files (`~/.kraken/tentacles/<name>.md`): a new tentacle, or just the fields to change
3. a chain stage's own settings (source `chain <name>`), for that stage only
4. the call's `agent` / `model` / `effort` (and `verify` for write runs); a call can never set `autonomy`

`tentacles()` shows every value and which layer it came from.

**Tentacle file format.** A `---` header of `key: value` lines (values are parsed as JSON when
possible: `null`, numbers, `true`/`false`; otherwise kept as text), a closing `---`, then the
prompt. Lines starting with `#` in the header are comments. The file name is the tentacle name:
lowercase letters, digits, `-` or `_`, up to 32 characters.

**Budgets.** Agents report different metrics: Codex and Cursor report no cost, and Cursor reports
no tokens either. A limit on a metric the agent does not report cannot be enforced; the start tool
says so in `warnings`, and `status` / `session` mark those metrics as `not_reported`.

## Chain files

Built-in chains are in `src/chains/<name>.md`, yours in `~/.kraken/chains/<name>.md` (same header
format as tentacle files; the body is notes for you and is never sent to an agent). A user file
overrides a built-in field by field; `stages` is replaced as a whole.

| Field | Meaning |
|---|---|
| `description` | One line shown in `tentacles()` and `krakenmcp chain list` |
| `stages` | JSON array of 1–8 stages: `{"tentacle": "<name>"}` plus optional `agent`, `model`, `effort`, `verify` (write stage only), `autonomy` |
| `max_fix_rounds` | 0–5 (default 1): fix rounds per chain |

**Stage kinds** come from the resolved tentacle: `review` (its prompt uses `{{diff}}`), `write`
(`access: write`) or `read`. A chain has at most one write stage; a write stage that uses `{{plan}}`
needs a read stage before it; review stages come after the write stage. `chain` checks all of this
before anything runs.

**Inputs.** Read stages get the task, the call's `context_runs` and the results of earlier read
stages. The write stage gets the latest earlier read run as its plan; its `verify` comes from the
call, then the stage, then the tentacle. Review stages review the write stage's branch.

**After a stage.** Autonomy `auto` starts the next stage; `ask` pauses the chain (`pause.reason:
"approval"`) and the reply to `resume(chain_id, reply)` reaches the next stage as a developer note.
A stage's autonomy is fixed when the chain starts. A failed, timed-out, over-budget or cancelled
stage ends the chain as `failed`.

**Fix rounds** never pause, even when the review's autonomy is `ask`: a review that requests changes
resumes the write run with the findings and reviews again; a failed verify resumes it with the
output. With no rounds left, a failed verify pauses the chain (`pause.reason: "verify_failed"`;
`resume(chain_id, instruction)` sends the instruction to the agent), and a review that still requests
changes ends the chain as `done` without merging.

**Merging.** When the last review approves and its autonomy is `auto`, the chain merges if nothing
blocks it (see `auto_merge_blocked_by` in the merge preview); otherwise it ends and `next` asks the
head to show the merge preview.

## CLI

```sh
krakenmcp                      # start the MCP server (what MCP clients run)
krakenmcp doctor               # installed agents and versions; exits 1 if a tentacle needs a missing one
krakenmcp show [run_id]        # a run's full result (default: the newest); --open in $VISUAL/$EDITOR, --log raw output
krakenmcp list                 # resolved tentacles for the current repo
krakenmcp edit <name>          # open ~/.kraken/tentacles/<name>.md in $VISUAL/$EDITOR (created if missing), then check it
krakenmcp remove <name>        # delete that file: your tentacle is gone, a built-in is back to its defaults
krakenmcp chain list           # resolved chains: stages, their kind and autonomy, and any problems
krakenmcp chain edit <name>    # open ~/.kraken/chains/<name>.md (created if missing), then check it
krakenmcp chain remove <name>  # delete that file: your chain is gone, a built-in is back to its defaults
krakenmcp limit [n]            # show / set how many runs may work at once (default 3)
krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
krakenmcp update               # reinstall a global git install; prints the old -> new version
krakenmcp --version            # print the installed version
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

- `kraken.db`: runs, chains, messages and the parallel-run limit (SQLite, WAL mode)
- `plans/<run_id>.md`: results of read tentacles (`krakenmcp show <run_id>` prints one)
- `tentacles/<name>.md`: your own tentacles and changes to the built-ins
- `chains/<name>.md`: your own chains and changes to the built-in ones
- `logs/<run_id>.log`: full raw agent output (`krakenmcp show <run_id> --log`)
- `worktrees/<run_id>/`: write runs' worktrees (removed by `merge`, `discard` or `prune --worktrees`)
