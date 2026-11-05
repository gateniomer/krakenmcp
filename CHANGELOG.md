# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

## [0.5.0] - Unreleased

### Added
- Approval mode: `krakenmcp mode auto` lets `merge` and pipelines land a branch by themselves when
  the latest review approves, verify passed, nothing conflicts and no checkout is dirty; anything
  less shows the usual preview with the reasons (`auto_merge_blocked_by`). Default stays `ask`.
- Warm session reuse: `reuse_session_min` on a read tentacle continues the agent session of its
  last run in the same session label when that finished recently (`explain` defaults to 5 minutes).
- Tentacles as Markdown files (a `---` settings header, then the prompt): your own in
  `~/.kraken/tentacles/<name>.md`, a repo's in `.kraken/tentacles/<name>.md` (trusted together with
  `.kraken/tentacles.json`). The built-ins moved to `src/tentacles/*.md`, unchanged.
- `session` tool: what needs the developer (running, waiting, ready to merge), recent runs and
  pipelines, and the totals `stats` gave.
- `krakenmcp show [run_id] [--open|--log]` prints a run's full result, opens it in `$VISUAL` /
  `$EDITOR`, or prints the raw agent output. `kraken://result/<id>` serves it as a Markdown resource,
  and the instructions ask the coordinator to give the developer the `result_file` path.
- `update(run_id)`: merges the developer's current branch into a run's branch. On conflicts the
  run's agent resolves them in its own session; Kraken refuses leftover conflict markers and
  commits the resolution to conclude the merge (`resolve: false` only lists the files).
- Merge previews predict conflicts with `git merge-tree` and point to `update`.
- Budgets: `max_cost_usd` and `max_tokens` per tentacle, checked every second against live
  usage (new status `over_budget`); Claude Code also gets `--max-budget-usd`. Daily spend limit
  with `krakenmcp budget <usd|off>`; new runs are refused once it is reached.
- `pipeline` tool: plan -> execute -> review, with fix rounds on `changes_requested` or a failed
  verify, driven by a detached process; stops before merge. `status` and `cancel` take pipeline ids.
- MCP progress notifications while `status` waits, a log message when a run or pipeline
  finishes, and runs as subscribable resources (`kraken://run/<id>`).
- Aider adapter (docs-checked, not run).
- Shared tentacles: `.kraken/tentacles.json` in a repository, used only after `krakenmcp trust`
  (tied to the file's hash); `krakenmcp export` / `import`.
- Experimental Windows support: PATHEXT lookup, npm `.cmd` shims run through node, process-tree
  kill with `taskkill`, `cmd.exe` for verify, PowerShell process ancestry. CI runs a
  non-blocking Windows job.
- Live cost and tokens on `status` while a run is going; `not_reported` marks metrics an agent
  does not report, in `status` and `stats`.
- A deleted worktree is recreated from its branch on resume, review or update.
- Manual npm release workflow with provenance; `prepublishOnly` runs the tests.
- `npm run test:smoke:pipeline`: the pipeline against a real agent (spends tokens).

### Fixed
- A run whose agent reported its failure on stdout (opencode provider errors such as
  ECONNREFUSED, Claude error results) showed only "exit 1: "; the agent's message is now the error.

### Changed
- Fewer tools, so each coordinator request carries less (20 -> 15): `runs` and `stats` are now
  `session`; `agents` is `tentacles(check_agents: true)`; `answer` is `resume` (on a `waiting` run
  its input is the answer). `configure_tentacle` and `about` are CLI-only (`krakenmcp set`,
  `krakenmcp about`): MCP clients can no longer store settings, so tentacle locks are gone.
- No runtime dependencies: Kraken speaks MCP over stdio itself (`src/mcp.js`) instead of using the
  MCP SDK and zod, which pulled in an HTTP stack. The SDK stays as a dev dependency for the tests.
- Coverage uses Node's built-in `--experimental-test-coverage`; `c8` and `.c8rc.json` are gone.
- `src/control.js` is split into `control.js`, `branches.js`, `scheduler.js` and `prune.js`; each
  agent adapter has its own file in `src/agents/`.
- README rewritten around the why, a quickstart and an example session; the reference moved to
  `docs/reference.md`.
- Claude Code adapter uses `--output-format stream-json --verbose` (per-tool counts, live usage).
- `cancel` sets a flag the worker polls instead of signalling it (works on every OS).
- The e2e test agent stub is a Node script (with POSIX and Windows entry points).

### Tests
- 93 tests (was 56): the MCP protocol and schemas, approval mode, warm sessions, tentacle files,
  `session`, `show` and the result resource, branch sync and conflict resolution, budgets, pipelines, notifications,
  repo tentacle files, export/import, killed agents, deleted worktrees, old-database migration,
  and the Windows code paths.

## [0.4.0] - Unreleased

First public release.

### Added
- MCP server with tentacles (named agent actions): `think`, `plan`, `execute`,
  `review`, `explain`, plus custom tentacles.
- Agent adapters for opencode (run against a real CLI), Claude Code, Codex and Cursor (docs-checked).
- Layered settings (built-in, global, repo, per call) with change log and locks.
- Control tools: `cancel`, `merge` (preview + confirm), `discard`, `answer`, `resume`.
- Per-run metrics (time, tokens incl. cache, cost, tool calls, diff size, verify) and `stats`.
- `krakenmcp` command: MCP server by default, developer config CLI with subcommands.
- Parallel-run limit (default 3, `krakenmcp limit`); extra runs wait as `queued`.
- Recovery of runs whose worker died: marked `failed`, orphaned agents stopped.
- `krakenmcp prune` for old logs, result files, stored prompts and abandoned worktrees.
- MCP server instructions with the recommended workflow; shorter tool descriptions
  (about 40% less tool-list context per request).
- Claude Code `--effort` support.
- Cursor CLI adapter (`cursor-agent` / `agent`): ask mode for read tentacles, `--force` for write.
- Nested-call guard: a Kraken server inside a Kraken run offers no tools; agents are told not to delegate.
- `agents` tool and `krakenmcp doctor`: installed agent CLIs, versions, and tentacles that need a missing one.

### Fixed
- The CLI applied settings to the wrong repository when started from another npm script
  (it trusted `INIT_CWD` everywhere; now only for `npm run` inside the package).
- Discarding or merging a run now also closes the runs that resumed it on the same branch.

### Tests
- 56 tests (unit + end-to-end through the real `krakenmcp` entry point against a stub
  agent), coverage gate in CI via c8: about 99% of lines and 83% of branches.
