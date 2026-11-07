# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `status` now returns a `summary` in every reply: a ready-made `headline`
  (`[ 🦑 plan › claude opus ]  ● running  42s    6 tools   using read`), tool counts, milestones, the
  agent's latest line and the waiting question. The head shows the headline and writes a short
  `So far:` / `Now:` line from it above the feed, so the developer can see where the tentacle is at.
  Progress notifications use the same headline.

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
