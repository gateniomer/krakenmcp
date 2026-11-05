<p align="center"><img src="assets/logo.svg" alt="KrakenMCP logo" width="420"></p>

# KrakenMCP

**One coordinator, many tentacles.** KrakenMCP is an MCP server that lets the coding agent you
are talking to hand work off to other headless coding agents (Claude Code, Codex, Cursor,
opencode, Aider), each with the model and effort you choose.

> **Status: early (0.x).** The opencode adapter is verified against a real CLI. The Claude Code,
> Codex, Cursor and Aider adapters are checked against their official CLI docs but not yet run
> end to end. Windows support is experimental. Expect breaking changes before 1.0.

## Why

One model for everything is either too expensive or not good enough. Kraken lets you:

- **Pay for thinking only where it matters.** A strong model designs and reviews; a cheap, fast
  one writes the code.
- **Keep your own chat small.** Delegated work runs in the background; only short summaries come
  back to your coordinator, and the full output stays in files you can open.
- **Never lose your checkout.** Code-writing agents work in a separate git worktree on a
  `kraken/<run_id>` branch. Nothing lands until you approve the merge.
- **Stay in charge.** Agents stop and ask when they need a decision; budgets stop runaway runs.

```
you <-> your coding agent (coordinator)
             |  MCP
             v
         KrakenMCP --think/plan/review--> strong model   (read-only)
                   --execute------------> cheap model    (git worktree, kraken/<run_id>)
                   --explain------------> cheap model    (read-only)
```

## Quickstart

You need Node.js 22.13+, git, and at least one agent CLI installed and logged in
([opencode](https://opencode.ai), [Claude Code](https://code.claude.com/docs),
[Codex](https://github.com/openai/codex), [Cursor CLI](https://cursor.com/docs/cli) or
[Aider](https://aider.chat)). Kraken has no runtime dependencies and never installs or logs in to
agents for you.

```sh
npx -y krakenmcp doctor                       # which agents Kraken found
claude mcp add kraken -- npx -y krakenmcp     # connect it (Claude Code; other clients: docs/reference.md)
npx -y krakenmcp set execute verify="npm test"   # optional: the check every code change must pass
```

Before the npm release, use a source checkout: `git clone`, `npm install`, and
`node /path/to/krakenmcp/src/bin.js` in place of `npx -y krakenmcp`.

Then, in your coding agent, just describe the feature. It knows the workflow from Kraken's
instructions.

## What a session looks like

The coordinator's tool calls are shown in `code`; everything else is ordinary chat.

> **You:** Add rate limiting to the public API. Per API key, 100 requests a minute.
>
> **Coordinator:** That touches the request path and needs shared state, so I'll get a second
> opinion. `think("per-key rate limiting for the public API …")` … The analysis recommends a
> sliding window in Redis over in-memory counters, because the API runs on 3 instances. Two
> open questions: should limits differ per plan, and what should a limited request return?
>
> **You:** Same limit for everyone. Return 429 with Retry-After.
>
> **Coordinator:** `pipeline("… same limit, 429 + Retry-After", verify: "npm test")` … It planned,
> implemented on branch `kraken/execute_7f3a`, tests pass, and the review approves. The plan is
> at `~/.kraken/plans/plan_91c2.md`. Here is the merge preview: 4 files, +182/−3, no conflicts.
> Merge it?
>
> **You:** Yes.
>
> **Coordinator:** `merge("execute_7f3a", confirm)`. Merged into `main`.

## Features

- **Tentacles.** Every action is a named job with a prompt, an access level and settings. Built in:
  `think`, `plan`, `execute`, `review`, `explain`. Add your own as Markdown files (below).
- **Read vs write.** Read tentacles run the agent in its read-only mode. Write tentacles commit to a
  `kraken/<run_id>` branch in their own worktree. An optional `verify` command must pass.
- **Pipelines.** `pipeline(task)` runs plan, execute and review by itself, with fix rounds when the
  review requests changes or verify fails.
- **Questions.** An agent that needs a decision stops as `waiting`; your coordinator asks you and
  passes your answer back with `resume`.
- **Branches that fell behind.** `update(run_id)` merges your branch into the run's; on conflicts the
  run's own agent resolves them.
- **Budgets and limits.** Per-tentacle `max_cost_usd` / `max_tokens` checked every second, a daily
  spend limit (`krakenmcp budget`), and at most 3 runs at once (`krakenmcp limit`).
- **Metrics.** Time, tokens (including cache), cost, tool calls, diff size and verify results for
  every run; `session` shows them per tentacle, agent and model.
- **Light on your context.** 15 short tools; the workflow is sent once as server instructions.
- **No chains.** Agents Kraken starts are told to do the work themselves, and a Kraken started
  inside a Kraken run offers no tools.

## Choose your models

Defaults: `think`, `plan` and `review` use Claude Code with Opus; `execute` and `explain` use
opencode with its configured default model. Change them globally or per repository:

```sh
krakenmcp set think agent=claude model=opus effort=high --global
krakenmcp set execute agent=opencode model=<provider/model> --global
krakenmcp set execute verify="npm test" --cwd ~/code/my-app
krakenmcp list                    # what each tentacle resolves to here, and why
```

Your coordinator can override `agent`, `model` and `effort` for a single call, but only you (the
CLI, or tentacle files) can change stored settings.

## Add a tentacle

A tentacle is a Markdown file: a `---` header with settings, then the prompt. Drop it in
`~/.kraken/tentacles/<name>.md` and it is available in every repository, no command needed.

```markdown
---
description: Audit dependencies for known problems and unused packages
access: read
agent: claude
model: sonnet
timeout_min: 10
---
You are the AUDITOR. Check the dependencies of this repository: {{task}}
List each problem as "[severity] package - problem - fix".
```

Your coordinator calls it with `run(tentacle: "audit", input: "package.json")`. A file can also
change only part of an existing tentacle: `~/.kraken/tentacles/plan.md` containing just
`---` / `effort: low` / `---`. The built-ins in [`src/tentacles/`](src/tentacles) use the same format.

**For a team**, check in `.kraken/tentacles/<name>.md`. Because those files can set prompts and
`verify` commands, Kraken ignores them until each developer reads them and runs `krakenmcp trust`
in that repository; any change needs trusting again.

All fields and how settings layer are in [docs/reference.md](docs/reference.md#tentacle-fields-and-settings-layers).

## Read what the agents wrote

Your coordinator sees short excerpts. You can read everything:

```sh
krakenmcp show                 # the newest run's full result (a plan, a review, an analysis)
krakenmcp show <run_id> --open # open it in $VISUAL / $EDITOR
krakenmcp show <run_id> --log  # the agent's raw output
```

Results are plain files in `~/.kraken/plans/<run_id>.md`, and clients that support MCP resources
can open `kraken://result/<run_id>`. Ask your coordinator for `session` to see what is running,
waiting for you, or ready to merge.

## Approval: ask or auto

By default (`krakenmcp mode ask`) every merge needs you: `merge` returns a preview, and only your
explicit yes lands it. `discard` also asks.

`krakenmcp mode auto` lets `merge` and pipelines land a branch by themselves, but only when the
latest review approves, the `verify` command you set (`krakenmcp set execute verify=…`, not one the
coordinator passed in the call) passed, nothing conflicts, and neither checkout has uncommitted
changes. Anything less falls back to the preview and says why. Switch back with
`krakenmcp mode ask`.

## Saving tokens

- Delegated output stays out of your coordinator's context: it gets summaries and file paths.
- Results flow between steps as text (`context_runs`, the plan), so the next agent does not
  re-read the codebase to rediscover them.
- `resume` and fix rounds continue the same agent session instead of starting over.
- **Warm sessions.** A read tentacle with `reuse_session_min` continues the agent session of its
  last run (same session label, repo and model) if that finished recently. Providers cache recent
  conversation history (often for about 5 minutes), so the shared history is cheap, and the agent
  keeps what it already read. `explain` does this for 5 minutes by default; turn it on for others
  with `krakenmcp set plan reuse_session_min=5`. Reviews and write runs always start fresh.

## Security

Write tentacles auto-approve agent actions inside a worktree, `verify` runs shell commands, and
`merge` changes your checkout. Read [SECURITY.md](SECURITY.md) before using KrakenMCP on code you
care about.

## Learn more

- [docs/reference.md](docs/reference.md): every tool, tentacle field, CLI command, agent adapter,
  and where data lives
- [CONTRIBUTING.md](CONTRIBUTING.md): code layout, tests, and how to add an agent
- [CHANGELOG.md](CHANGELOG.md)

## Development

```sh
npm install              # dev only: the MCP SDK, whose client drives the e2e tests
npm test                 # unit + end-to-end tests (stub agent, no tokens, about 2 minutes)
npm run test:coverage    # the same with Node's built-in coverage; fails below the thresholds in package.json
npm run test:smoke -- <throwaway-git-repo> "<task>" opencode opencode "npm test"   # REAL agent, spends tokens
```

## License

[MIT](LICENSE)
