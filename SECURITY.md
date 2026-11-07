# Security

Kraken runs coding-agent CLIs on your machine. Understand what that means before
using it on code you care about.

## What Kraken does on your behalf

- **Write tentacles auto-approve agent actions.** `execute` (and any custom write
  tentacle) starts the agent with its auto-approve flag (`opencode --auto`,
  `claude --permission-mode acceptEdits`, `codex --sandbox workspace-write`). This
  always happens in a separate git worktree, never in your checkout.
- **`verify` runs a shell command** you (or a configured tentacle) chose, in the
  run's working directory (`/bin/sh`).
- **Tentacle settings come only from you**: built-ins and your own
  `~/.kraken/tentacles/`. Kraken never reads tentacle settings from a repository, so a cloned repository
  cannot set prompts or `verify` commands.
- **`update` resumes an agent with write access** to resolve merge conflicts in the run's
  worktree. Kraken commits the result only if no conflict markers are left.
- **Aider write runs** use `--yes-always`, inside the worktree like other write runs.
- **Budgets are best effort.** `max_cost_usd` and `max_tokens` rely on the
  numbers each agent prints and are checked once a second, so a run can go slightly over.
  Agents that report no cost (Codex, Cursor) are not limited by cost.
- **`merge` changes your checkout** but only with the `confirm_token` from a preview.
  The tool tells the calling model to get your approval first; Kraken cannot verify
  that a human approved it.
- **Review `autonomy: auto` merges without asking** when the latest review approves, `verify`
  passed, nothing conflicts and neither checkout has uncommitted changes. Only your tentacle
  files can turn it on (a call cannot set `autonomy`). The `verify` command must come from your
  files: one the head passed in the call (`execute` / `chain` take `verify`) does not count. A
  reviewer is a model, so this trusts its verdict and your `verify` command. Telling the head to
  "work in auto this session" is followed by the head only; it cannot get past these checks,
  because `merge` without `confirm` still only previews unless the review's autonomy is `auto`.
- **Settings change only through your tentacle files.** MCP clients can override `agent`,
  `model`, `effort`, and for write runs `verify`, for one call, but cannot store
  settings or change prompts.
- **No nested delegation.** Agents Kraken starts are told not to delegate, and a Kraken
  server started inside a Kraken run (detected from `KRAKEN_PARENT_RUN` or its parent
  processes) offers no tools. Write tentacles still auto-approve; cursor's `--force` and
  `--trust` are passed for write runs, `--trust` for read runs.
- **Read tentacles** use each agent's read-only mode, plus a fixed instruction not to
  edit files. Agent sandboxes differ; treat "read" as best effort, not a security boundary.

Kraken does not send data anywhere itself. The agent CLIs you configure talk to their
own providers under their own terms.

## Data

Runs, prompts, results and logs are stored unencrypted in `~/.kraken`
(or `$KRAKEN_DATA`). Prompts can contain source code and diffs.

## Reporting a vulnerability

Please report security issues privately through GitHub's
"Report a vulnerability" (Security tab) rather than a public issue.
