// SQLite store shared by the MCP server, the CLI and the background workers.
// Uses Node's built-in node:sqlite (Node 22.5+), WAL mode so several
// processes can read/write at once.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
    verify_output  TEXT
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
  -- Tentacle settings per scope: 'global' or 'repo:<absolute repo path>'.
  CREATE TABLE IF NOT EXISTS tentacles (
    scope      TEXT NOT NULL,
    name       TEXT NOT NULL,
    settings   TEXT NOT NULL,               -- JSON with only the fields set at this scope
    locked     INTEGER NOT NULL DEFAULT 0,  -- unused since 0.5 (only the CLI stores settings)
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, name)
  );
  CREATE TABLE IF NOT EXISTS config_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT NOT NULL,
    name       TEXT NOT NULL,
    actor      TEXT NOT NULL,               -- 'cli:developer' ('mcp:<client name>' before 0.5)
    action     TEXT NOT NULL,               -- set | reset | limit | budget | mode | trust | untrust
    before     TEXT,
    after      TEXT,
    created_at TEXT NOT NULL
  );
  -- Server-wide settings, e.g. max_parallel, daily_budget_usd.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Pipelines: plan -> execute -> review (-> resume + review again), driven by pipeline.js.
  CREATE TABLE IF NOT EXISTS pipelines (
    id           TEXT PRIMARY KEY,
    session      TEXT NOT NULL DEFAULT 'default',
    task         TEXT NOT NULL,
    cwd          TEXT NOT NULL,
    options      TEXT NOT NULL,          -- JSON: verify, max_fix_rounds, context_runs, overrides per stage
    status       TEXT NOT NULL DEFAULT 'running', -- running | waiting | done | failed | cancelled
    stage        TEXT NOT NULL DEFAULT 'plan',    -- plan | execute | review | fix | finished
    current_run  TEXT,                   -- the run the pipeline is waiting on
    plan_run     TEXT,
    exec_run     TEXT,                   -- latest write run on the branch (execute or its fix)
    review_run   TEXT,
    fix_rounds   INTEGER NOT NULL DEFAULT 0,
    pid          INTEGER,                -- driver process
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    result       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    finished_at  TEXT
  );
`);

// Columns added after 0.4.0: add them to databases created by older versions.
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('runs', {
  cancel_requested: 'INTEGER NOT NULL DEFAULT 0', // set by cancel(); the worker polls it (portable, no signals)
  stop_reason: 'TEXT',                            // why Kraken stopped it: budget details
  pipeline_id: 'TEXT',
});

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
                pipeline_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.session, r.tentacle, r.access, r.plan_id ?? null, r.task, r.agent, r.model ?? null,
         r.effort ?? null, r.prompt, r.config ? JSON.stringify(r.config) : null, r.timeout_min ?? null,
         r.cwd, r.workdir, r.branch ?? null, r.verify_cmd ?? null, r.base_sha ?? null, r.resumed_from ?? null,
         r.native_session ?? null, r.target_run ?? null, r.pipeline_id ?? null, nowIso());
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

export const listRuns = (session, limit = 20) =>
  db.prepare(`SELECT id, tentacle, access, plan_id, agent, model, effort, status, outcome, verdict, duration_ms, cost_usd,
                substr(task,1,80) AS task, created_at, finished_at
              FROM runs WHERE session = ? ORDER BY created_at DESC LIMIT ?`).all(session, limit);

export const allRuns = (session) =>
  db.prepare('SELECT * FROM runs WHERE session = ? ORDER BY created_at').all(session);

// ---- tentacle config ----

export const getTentacleRow = (scope, name) =>
  db.prepare('SELECT * FROM tentacles WHERE scope = ? AND name = ?').get(scope, name);

export const tentacleRows = (scopes) =>
  db.prepare(`SELECT * FROM tentacles WHERE scope IN (${scopes.map(() => '?').join(',')})`).all(...scopes);

export function saveTentacleRow({ scope, name, settings, actor, action, before }) {
  db.prepare(`INSERT INTO tentacles (scope, name, settings, locked, updated_by, updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT (scope, name) DO UPDATE SET settings = excluded.settings, locked = excluded.locked,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(scope, name, JSON.stringify(settings), 0, actor, nowIso());
  logChange({ scope, name, actor, action, before, after: { settings } });
}

export function deleteTentacleRow({ scope, name, actor, before }) {
  db.prepare('DELETE FROM tentacles WHERE scope = ? AND name = ?').run(scope, name);
  logChange({ scope, name, actor, action: 'reset', before, after: null });
}

function logChange({ scope, name, actor, action, before, after }) {
  db.prepare('INSERT INTO config_changes (scope, name, actor, action, before, after, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(scope, name, actor, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, nowIso());
}

export const configChanges = (limit = 20) =>
  db.prepare('SELECT * FROM config_changes ORDER BY id DESC LIMIT ?').all(limit);

// Latest review of a run (review runs record target_run + verdict).
export const latestReview = (runId) =>
  db.prepare(`SELECT id, status, verdict, agent, model, finished_at FROM runs
              WHERE target_run = ? AND tentacle = 'review' ORDER BY created_at DESC LIMIT 1`).get(runId);

// The run that resumed `id` (answer / resume create a new run with resumed_from = id).
export const resumedBy = (id) =>
  db.prepare('SELECT id FROM runs WHERE resumed_from = ? ORDER BY created_at DESC LIMIT 1').get(id)?.id ?? null;

// Spend since local midnight, for the daily budget.
export function spentToday() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE created_at >= ?').get(midnight.toISOString()).c;
}

// ---- pipelines ----

export function insertPipeline(p) {
  db.prepare('INSERT INTO pipelines (id, session, task, cwd, options, created_at) VALUES (?,?,?,?,?,?)')
    .run(p.id, p.session, p.task, p.cwd, JSON.stringify(p.options), nowIso());
}
export const getPipeline = (id) => db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id);
export function updatePipeline(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE pipelines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}
export const listPipelines = (session, limit = 20) =>
  db.prepare(`SELECT id, status, stage, current_run, fix_rounds, substr(task,1,80) AS task, created_at, finished_at
              FROM pipelines WHERE session = ? ORDER BY created_at DESC LIMIT ?`).all(session, limit);

// ---- server-wide settings ----

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export function setSetting(key, value, actor, action = 'limit') {
  const before = getSetting(key);
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  db.prepare('INSERT INTO config_changes (scope, name, actor, action, before, after, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('global', key, actor, action, before, value === null ? null : String(value), nowIso());
}
