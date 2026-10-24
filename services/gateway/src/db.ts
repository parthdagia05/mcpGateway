// Postgres: connection pool, schema, and change notifications between gateway replicas.
//
// Tables:
//   users       - team members (admin | member). password_hash is null until an invite is accepted.
//   sessions    - dashboard logins. We store only a HASH of the session token that sits in the browser cookie.
//   api_keys    - per-user gateway keys. Only a hash is stored; the full key is shown once at creation.
//   servers     - registered upstream MCP servers. Credentials are stored ENCRYPTED (auth_secret_enc).
//   audit_logs  - one row per tool call: who, which server/tool, when, how long, outcome.
//   tool_policies - admin overrides of who may use a tool (members or admins only).
//   meta        - small key/value flags (e.g. "servers were seeded once").

import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash     TEXT,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS servers (
  id               SERIAL PRIMARY KEY,
  name             TEXT UNIQUE NOT NULL,
  url              TEXT NOT NULL,
  auth_type        TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header      TEXT,
  auth_secret_enc  TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  timeout_ms       INT NOT NULL DEFAULT 15000,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      INT,
  user_email   TEXT,
  source       TEXT NOT NULL,
  server_name  TEXT,
  tool         TEXT NOT NULL,
  duration_ms  INT,
  outcome      TEXT NOT NULL,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS audit_logs_ts_idx ON audit_logs (ts DESC);

-- Per-tool permission overrides. No row = the default from the tool's own annotations (see permissions.ts).
CREATE TABLE IF NOT EXISTS tool_policies (
  server_id  INT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  min_role   TEXT NOT NULL CHECK (min_role IN ('member', 'admin')),
  PRIMARY KEY (server_id, tool)
);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/**
 * On a fresh install the gateway Pods often start before Postgres is ready. Instead of crashing
 * (and showing restarts in "kubectl get pods"), wait for it: retry every 2s for up to 2 minutes.
 */
export async function waitForDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= 60) throw err;
      if (attempt === 1 || attempt % 5 === 0) console.log(`waiting for Postgres (${(err as Error).message})...`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** Creates any missing tables. Safe to run on every start, from several replicas at once (advisory lock). */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(SCHEMA);
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}

// ---------- Change notifications ----------
// When an admin adds/edits/removes a server on ONE gateway replica, every other replica must
// reload its upstream connections too. Postgres LISTEN/NOTIFY does that: the replica that made the change
// sends NOTIFY, and every replica (including itself) is LISTENing and reloads.

const CHANNEL = "servers_changed";

export async function notifyServersChanged() {
  await pool.query(`NOTIFY ${CHANNEL}`);
}

/** Calls onChange whenever any replica changes the servers table. Reconnects if the connection drops. */
export async function listenForServerChanges(onChange: () => void) {
  const connect = async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on("notification", () => onChange());
    client.on("error", () => {
      client.end().catch(() => {});
      setTimeout(connect, 2_000);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch {
      setTimeout(connect, 2_000);
    }
  };
  await connect();
}
