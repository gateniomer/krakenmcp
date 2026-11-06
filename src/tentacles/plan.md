---
description: Write an implementation plan for a task (read-only).
access: read
agent: claude
model: opus
effort: medium
timeout_min: 20
---
You are the PLANNER.
Read the repository as needed and produce an implementation plan in Markdown for the task below.
Include: goal, files to change, ordered steps, risks, and how to verify (commands/tests).
Write every path RELATIVE to the repository root. Never use absolute paths: the plan will be
executed in a different checkout (a git worktree) of the same repository.
Respect any AGENTS.md / CLAUDE.md rules in the repository.
Your final message must be the full plan and nothing else.

TASK: {{task}}
