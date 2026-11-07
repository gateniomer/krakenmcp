// SQLite store shared by the MCP server, the CLI and the background workers.
// Uses Node's built-in node:sqlite (Node 22.5+), WAL mode so several
// processes can read/write at once.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Per-user data (database, plans, logs, worktrees). Override with KRAKEN_DATA.
export const DATA_DIR = process.env.KRAKEN_DATA || join(homedir(), '.kraken');
export const PLANS_DIR = join(DATA_DIR, 'plans');   // results of read tentacles, as Markdown
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const WORKTREES_DIR = join(DATA_DIR, 'worktrees');
for (const d of [DATA_DIR, PLANS_DIR, LOGS_DIR, WORKTREES_DIR]) mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'kraken.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    session        TEXT NOT NULL DEFAULT 'default',
    tentacle       TEXT NOT NULL,          -- think, plan, execute, review, explain or a custom name
    access         TEXT NOT NULL,          -- read | write (enforced via agent flags)
    plan_id        TEXT,                   -- input run whose result was fed in as {{plan}}
    task           TEXT NOT NULL,
    agent          TEXT NOT NULL,
    model          TEXT,
    effort         TEXT,
    prompt         TEXT,                   -- fully rendered prompt sent to the agent
    config         TEXT,                   -- JSON: resolved tentacle settings + where each came from
    timeout_min    REAL,
    cwd            TEXT NOT NULL,          -- the repository
    workdir        TEXT NOT NULL,          -- where the agent runs (repo, or a worktree)
    branch         TEXT,                   -- kraken/<run_id> for worktree runs
    base_sha       TEXT,                   -- commit the worktree branch started from
    status         TEXT NOT NULL DEFAULT 'queued',
    pid            INTEGER,                -- worker process; -1 = claimed by the scheduler, not started yet
    agent_pid      INTEGER,                -- agent process (its own process group)
    claimed_at     TEXT,
    native_session TEXT,                   -- the agent's own session id (resume / answer)
    resumed_from   TEXT,
    target_run     TEXT,                   -- the run a review looked at
    question       TEXT,                   -- KRAKEN_QUESTION when status is 'waiting'
    verdict        TEXT,                   -- review verdict: approve | changes_requested
    outcome        TEXT,                   -- merged | discarded
    outcome_detail TEXT,
    result         TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    duration_ms    INTEGER,
    exit_code      INTEGER,
    tokens         TEXT,                   -- JSON {input, output, reasoning, cache_read, cache_write}
    cost_usd       REAL,
    steps          INTEGER,
    tool_calls     TEXT,                   -- JSON {total, failed, by_tool}
    diff_stat      TEXT,                   -- JSON {files, insertions, deletions}
    verify_cmd     TEXT,
    verify_exit    INTEGER,
    verify_output  TEXT,
    chain_id       TEXT,
    chain_stage    INTEGER                 -- index of the chain stage this run belongs to
  );
  CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT NOT NULL DEFAULT 'default',
    run_id     TEXT,
    sender     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Server-wide settings, e.g. max_parallel.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Chains: an ordered list of tentacle stages (src/chains/, ~/.kraken/chains/), driven by chain.js.
  DROP TABLE IF EXISTS pipelines;
  CREATE TABLE IF NOT EXISTS chains (
    id           TEXT PRIMARY KEY,
    session      TEXT NOT NULL DEFAULT 'default',
    name         TEXT NOT NULL DEFAULT 'default',
    task         TEXT NOT NULL,
    cwd          TEXT NOT NULL,
    options      TEXT NOT NULL,          -- JSON: verify, max_fix_rounds, context_runs, overrides
    stages       TEXT NOT NULL,          -- JSON snapshot of the checked stages (checkChain)
    status       TEXT NOT NULL DEFAULT 'running', -- running | waiting | done | failed | cancelled
    stage_index  INTEGER NOT NULL DEFAULT 0,
    stage        TEXT,                   -- tentacle of the current stage, fix, or finished
    current_run  TEXT,                   -- the run the chain is waiting on
    write_run    TEXT,                   -- latest write run on the branch (the write stage or its fix)
    pause        TEXT,                   -- JSON {reason: approval | verify_failed, after, next_stage}
    note         TEXT,                   -- the developer's input for the next stage
    fix_rounds   INTEGER NOT NULL DEFAULT 0,
    pid          INTEGER,                -- driver process; null while paused
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    result       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    finished_at  TEXT
  );
`);

// Columns added later: add them to databases created by older versions.
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('runs', {
  cancel_requested: 'INTEGER NOT NULL DEFAULT 0', // set by cancel(); the worker polls it (portable, no signals)
  stop_reason: 'TEXT',                            // why Kraken stopped it: budget details
  chain_id: 'TEXT',
  chain_stage: 'INTEGER',
});
// Left by older versions: stored tentacle settings, their change log, repo-file trust, daily budget.
db.exec(`DROP TABLE IF EXISTS tentacles; DROP TABLE IF EXISTS config_changes;
  DELETE FROM settings WHERE key LIKE 'trust:%' OR key = 'daily_budget_usd' OR key = 'approval_mode';`);

// Statuses: queued, running (in progress); done, failed, verify_failed, timeout, cancelled,
// over_budget (stopped at max_cost_usd / max_tokens); waiting (the agent asked the developer a
// question; resume() answers it).
export const IN_PROGRESS = ['queued', 'running'];

export const nowIso = () => new Date().toISOString();

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

// ---- runs ----

export function insertRun(r) {
  db.prepare(`INSERT INTO runs (id, session, tentacle, access, plan_id, task, agent, model, effort, prompt, config,
                timeout_min, cwd, workdir, branch, verify_cmd, base_sha, resumed_from, native_session, target_run,
                chain_id, chain_stage, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.session, r.tentacle, r.access, r.plan_id ?? null, r.task, r.agent, r.model ?? null,
         r.effort ?? null, r.prompt, r.config ? JSON.stringify(r.config) : null, r.timeout_min ?? null,
         r.cwd, r.workdir, r.branch ?? null, r.verify_cmd ?? null, r.base_sha ?? null, r.resumed_from ?? null,
         r.native_session ?? null, r.target_run ?? null, r.chain_id ?? null, r.chain_stage ?? null, nowIso());
}

export const getRun = (id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);

export function updateRun(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

export function addMessage({ session = 'default', run_id = null, sender, kind, body }) {
  db.prepare('INSERT INTO messages (session, run_id, sender, kind, body) VALUES (?,?,?,?,?)')
    .run(session, run_id, sender, kind, body);
}

export const recentMessages = (runId, limit = 5) =>
  db.prepare('SELECT sender, kind, body, created_at FROM messages WHERE run_id = ? ORDER BY id DESC LIMIT ?')
    .all(runId, limit).reverse();

export const messagesSince = (runId, since = 0, limit = 200) =>
  db.prepare('SELECT id, run_id, sender, kind, body FROM messages WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
    .all(runId, since, limit);
export const chainMessagesSince = (pid, since = 0, limit = 200) =>
  db.prepare(`SELECT m.id, m.run_id, m.sender, m.kind, m.body FROM messages m JOIN runs r ON r.id = m.run_id
              WHERE r.chain_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(pid, since, limit);
// Read every row after `since` (page by page), for the final reply: nothing may be dropped.
export const messagesSinceAll = (runId, since = 0) => {
  const out = [];
  for (let after = since;;) {
    const rows = messagesSince(runId, after);
    out.push(...rows);
    if (rows.length < 200) return out;
    after = rows.at(-1).id;
  }
};
export const chainMessagesSinceAll = (pid, since = 0) => {
  const out = [];
  for (let after = since;;) {
    const rows = chainMessagesSince(pid, after);
    out.push(...rows);
    if (rows.length < 200) return out;
    after = rows.at(-1).id;
  }
};
export const lastMessageId = (runId) =>
  db.prepare('SELECT MAX(id) AS id FROM messages WHERE run_id = ?').get(runId)?.id ?? 0;
export const lastChainMessageId = (pid) =>
  db.prepare('SELECT MAX(m.id) AS id FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.chain_id = ?').get(pid)?.id ?? 0;
export const chainRuns = (cid) =>
  db.prepare('SELECT id, tentacle, resumed_from, config, cost_usd, chain_stage, status FROM runs WHERE chain_id = ? ORDER BY created_at, rowid').all(cid);
// Every tool line of a run (or of all runs of a chain), for the live summary's tool count.
export const toolMessages = (runId) =>
  db.prepare("SELECT body FROM messages WHERE run_id = ? AND kind = 'progress' AND body LIKE 'tool: %' ORDER BY id").all(runId);
export const chainToolMessages = (pid) =>
  db.prepare(`SELECT m.body FROM messages m JOIN runs r ON r.id = m.run_id
              WHERE r.chain_id = ? AND m.kind = 'progress' AND m.body LIKE 'tool: %' ORDER BY m.id`).all(pid);

export const listRuns = (session, limit = 20) =>
  db.prepare(`SELECT id, tentacle, access, plan_id, agent, model, effort, status, outcome, verdict, duration_ms, cost_usd,
                substr(task,1,80) AS task, created_at, finished_at
              FROM runs WHERE session = ? ORDER BY created_at DESC LIMIT ?`).all(session, limit);

export const allRuns = (session) =>
  db.prepare('SELECT * FROM runs WHERE session = ? ORDER BY created_at').all(session);

// Latest review of a run (review runs record target_run + verdict).
export const latestReview = (runId) =>
  db.prepare(`SELECT id, tentacle, status, verdict, agent, model, finished_at FROM runs
              WHERE target_run = ? AND (tentacle = 'review' OR verdict IS NOT NULL) ORDER BY created_at DESC LIMIT 1`).get(runId);

// The run that resumed `id` (answer / resume create a new run with resumed_from = id).
export const resumedBy = (id) =>
  db.prepare('SELECT id FROM runs WHERE resumed_from = ? ORDER BY created_at DESC LIMIT 1').get(id)?.id ?? null;

// ---- chains ----

export function insertChain(c) {
  db.prepare('INSERT INTO chains (id, session, name, task, cwd, options, stages, stage, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(c.id, c.session, c.name, c.task, c.cwd, JSON.stringify(c.options), JSON.stringify(c.stages), c.stage ?? null, nowIso());
}
export const getChain = (id) => db.prepare('SELECT * FROM chains WHERE id = ?').get(id);
export function updateChain(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE chains SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}
export const listChains = (session, limit = 20) =>
  db.prepare(`SELECT id, name, status, stage, stage_index, current_run, fix_rounds, substr(task,1,80) AS task, created_at, finished_at
              FROM chains WHERE session = ? ORDER BY created_at DESC LIMIT ?`).all(session, limit);

// ---- server-wide settings ----

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export function setSetting(key, value) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
