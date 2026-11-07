# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [2.1.3] - 2026-11-07

### Added
- `krakenmcp poll [seconds]` sets how long each status call waits while a run is busy (5–55, default 25,
  was a fixed 50). Start replies and the `tentacles` limits show it.

### Changed
- Less noise in the chat: while a run is busy, clients that show progress notifications (Claude Code)
  get a live status line under the pending call, and the head writes nothing between polls. It shows
  the card when it calls a tentacle and when the run ends, pauses or asks a question. Clients without
  progress notifications still get the card on every poll.
- The live line refreshes at least every 5 seconds (was 10), shows the model without its provider
  prefix, and for a chain shows every stage with its mark.

## [2.1.2] - 2026-11-07

### Fixed
- `krakenmcp update` failed with `Permission denied (publickey)` for `github.com/null/main.git`: it
  passed `github:…@main`, which npm reads as a version. It now installs `github:gateniomer/krakenmcp#main`.
  Installs from 2.1.1 and older must run `npm install -g github:gateniomer/krakenmcp` once by hand.
- The repository links and install command use the repository's current name, `krakenmcp`.

## [2.1.1] - 2026-11-07

### Changed
- Internal refactor, no change in how Kraken behaves: shared git and JSON helpers, `runs.js` and
  `chain.js` split by job, long functions broken up, server instructions in `src/instructions.md`,
  and every line in `src/` within 110 characters (checked by a test).

### Fixed
- The `tentacles` tool's `repo` field was always empty; it now shows the repository root.

## [2.1.0] - 2026-11-07

### Added
- Cards: every start tool, `resume` and every `status` reply returns `card`, a bordered box drawn by
  Kraken (tentacle, agent and model; then progress; then the result and the next step; for a chain, a
  mark per stage). The server instructions tell the head to show it as-is when it calls a tentacle, on
  every poll (also when there are no new feed lines) and when the run ends.

### Changed
- The head no longer writes its own "So far / Now" lines; the card carries that state. `summary` and its
  `headline` stay (the headline is used for progress notifications).

## [2.0.0] - 2026-11-07

### Breaking
- The `pipeline` tool is replaced by `chain`. Chain ids start with `chain_` and runs carry `chain_id`
  instead of `pipeline_id`; old pipeline records are dropped.
- `krakenmcp mode` and the `approval_mode` setting are removed (a stored setting is deleted). Merging
  now follows the review tentacle's `autonomy`. `tentacles().limits.approval_mode` is gone, and the
  merge preview has `review_autonomy` instead of `approval_mode`.
- The default chain pauses after each stage whose tentacle's autonomy is `ask` (the default), so on a
  fresh install it pauses after plan and after execute.
- A failed `verify` with no fix rounds left pauses a chain instead of going on to review.

### Added
- `autonomy: ask | auto` on every tentacle: whether the head (or a chain) may take the step after a
  successful run without asking. Questions, failures and `verify_failed` always stop.
- Chains: an ordered list of tentacle stages in a file, built in (`src/chains/default.md`) or your own
  (`~/.kraken/chains/<name>.md`), with per-stage settings, approval pauses answered with
  `resume(chain_id, reply)`, and `krakenmcp chain list|edit|remove`.
- Every finished run and chain returns a `next` starting with `ask:`, `auto:` or `stop:`.
- The server instructions describe a session override ("work in auto this session") that the head
  follows without storing anything; it never covers questions, failures or merge blockers.
- The merge preview always lists `auto_merge_blocked_by`.

### Fixed
- The docs said the pipeline "stops before merge" while in auto mode it merged by itself.

## [1.2.0] - 2026-11-07

### Added
- `status` now returns a `summary` in every reply: a ready-made `headline`
  (`[ 🦑 plan › claude opus ]  ● running  42s    6 tools   using read`), tool counts, milestones, the
  agent's latest line and the waiting question. The head shows the headline and writes a short
  `So far:` / `Now:` line from it above the feed, so the developer can see where the tentacle is at.
  Progress notifications use the same headline.
- `krakenmcp update` reinstalls the global install from GitHub `main` and reports the old and new
  version. It refuses to overwrite a source checkout or an `npm link`; `krakenmcp --version` prints
  the installed version.

## [1.1.0] - 2026-11-06

### Added
- `status` takes `since` and returns `feed` (ready-made progress lines for the head to show the developer)
  and `cursor`. While a run is in progress and `since` is given, the reply is compact. Pipeline replies
  also carry a `cursor`, and the developer's answers show as `developer: ANSWER:` in the feed.
- The head can now show the tentacle's progress in its own chat while it waits, using the `feed` lines,
  and keep following after answering a question.

### Changed
- A failed, timed-out or over-budget run (or a failed pipeline) returns `next` telling the head to stop
  and report the error, and the server instructions forbid retrying on another agent or model on its own.
- Default models and efforts for the built-in tentacles: `execute` and `explain` use
  `opencode-go/deepseek-v4.1-flash`; `plan` and `research` use `medium` effort; `think` and `review`
  use `medium` instead of `high`.

### Fixed
- OpenCode runs use `--standalone`, so they no longer fail when the developer's background
  `opencode serve --service` holds the managed service port.
- The final `status` reply reads every progress row, so the `done`/verdict line is not dropped after a
  chatty run, and agent text starting with `started`/`resumed` is no longer mistaken for a lifecycle line.

## [1.0.0] - 2026-11-06

First public release.

### Added
- MCP server (stdio, no runtime dependencies) with 15 tools. Every action is a tentacle: built-in
  `think`, `plan`, `execute`, `review`, `explain`, `research` (online, with sources), and your own
  via `run`.
- Tentacles are Markdown files: a `---` settings header, then the prompt. Built-ins ship in
  `src/tentacles/`; yours, or changes to the built-ins, go in `~/.kraken/tentacles/<name>.md`.
  The head (your coding agent) can override `agent`, `model` and `effort` (and `verify` for write runs) per call.
- Agent adapters: Claude Code and OpenCode; Codex, Cursor and Aider untested.
- Write tentacles work in a separate git worktree on a `kraken/<run_id>` branch. An optional
  `verify` command must pass; `review`, `merge` (preview, then confirm), `discard` and `update`
  (merge your branch in, the agent resolves conflicts) handle the branch.
- `pipeline`: plan -> execute -> review with fix rounds; stops before merge.
- Approval mode: `krakenmcp mode auto` merges by itself when the review approved, your `verify`
  passed and nothing conflicts. Default `ask`.
- Questions: an agent that needs a decision stops as `waiting`; `resume` passes the answer back.
- Budgets: `max_cost_usd` / `max_tokens` per tentacle, checked every second; at most 3 runs at
  once (`krakenmcp limit`).
- Metrics per run (time, tokens, cost, tool calls, diff size, verify) in `status`; totals per
  tentacle / agent / model in `session`, with what needs you.
- Progress notifications while `status` waits.
- CLI: `doctor`, `list`, `edit`, `remove`, `show`, `mode`, `limit`, `prune`.
- Nested-call guard: a Kraken started inside a Kraken run offers no tools.
- Runs on macOS and Linux.
