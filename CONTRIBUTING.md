# Contributing

Thanks for helping. Kraken is small on purpose; please keep changes focused.

## Setup

```sh
git clone <your fork>
cd krakenmcp
npm install
npm test        # unit tests + end-to-end tests against a stub agent (no tokens)
npm run test:coverage
```

Requires Node 22.13+ (for `node:sqlite`), git, and macOS or Linux.

## Layout

| Path | What it is |
|---|---|
| `src/bin.js` | `krakenmcp` entry: server by default, CLI with a subcommand |
| `src/server.js` | MCP tool definitions and server instructions |
| `src/mcp.js`, `src/schema.js` | The MCP protocol over stdio (no SDK) and tool input schemas with their validator |
| `src/runs.js` | Creating runs, status views, the session summary and stats |
| `src/control.js` | cancel and resume (which also answers a waiting run) |
| `src/branches.js` | Git and `kraken/<run_id>` branches: merge (following the review's autonomy), discard, update, review diffs |
| `src/scheduler.js` | Parallel-run limit, starting workers, recovering dead runs |
| `src/prune.js` | `krakenmcp prune` |
| `src/worker.js` | Background process that runs one agent, enforces budgets and records the result |
| `src/chains.js`, `src/chains/*.md` | Chain files: parsing, layering and checks; the built-in chains |
| `src/chain.js`, `src/chain-driver.js` | Chain state machine and the detached process that drives it |
| `src/platform.js` | Everything OS-specific: finding and starting executables, killing process trees, shells |
| `src/tentacles.js` | Tentacle files, layered settings, prompt rendering |
| `src/tentacles/*.md` | The built-in tentacles: settings header plus prompt |
| `src/agents.js`, `src/agents/*.js` | The adapter contract and registry; one file per agent CLI: flags in, normalized metrics out |
| `src/store.js` | SQLite schema and queries |
| `test/unit/` | `node:test` unit tests (settings, tentacle files, prompts, adapters, the MCP protocol) |
| `test/e2e/` | Starts the real server through `krakenmcp` and drives it over MCP; agents are the stub in `test/e2e/fakebin/stub.mjs` (entry point `opencode`) |
| `test/smoke/` | Manual run against a real agent (spends tokens); not part of `npm test` |

## Guidelines

- Add or update tests with every behaviour change. `npm test` must pass, and
  `npm run test:coverage` must stay above the thresholds in its `package.json` script.
- Test behaviour, not implementation: assert what a user or agent would observe (run
  status, files in the repo, branches, what the agent CLI received). Every e2e file gets
  its own temporary repo and data directory from `test/e2e/helpers.js`.
- A new test should fail when the behaviour it covers is broken. Check that by breaking
  the code once before you commit the test.
- New agent support goes in `src/agents/<name>.js`, listed in `AGENTS` in `src/agents.js` (the
  contract is at the top of that file): `build()` must map `read` access to the agent's read-only
  mode, and `reports` must say which metrics its output contains. Mark flags you could not verify
  against a real CLI.
- New built-in tentacles go in `src/tentacles/<name>.md`.
- No runtime dependencies. The MCP SDK is a dev dependency only, so the e2e tests check the
  protocol with the official client.
- Tool descriptions are read by models. Keep them plain and explicit about when to call.
- Merges need the developer's approval. The only exception is `autonomy: auto` on the review
  tentacle, which the developer sets in their own files; it merges only approved, verified,
  conflict-free branches. Never
  add code that installs software or sends data anywhere other than the agent CLIs the user
  configured.
- Update `CHANGELOG.md` under the unreleased version.
