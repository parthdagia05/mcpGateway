// The dashboard's REST API (JSON under /api). The React app is the only intended client.
//
//   /api/auth/*     login, logout, who am I, accept an invite          (public / any logged-in user)
//   /api/servers    list servers + status + tools                      (any logged-in user)
//                   add / edit / disable / remove / re-check           (admin only)
//   /api/users      invite, change role, remove                        (admin only)
//   /api/keys       create / list / revoke YOUR keys                   (any logged-in user)
//                   list / revoke ANYONE's keys                        (admin only)
//   /api/audit      the audit log: admins see everyone, members see their own calls
//   /api/chat       ask the chat agent; it calls tools as YOU (audited under your name)
//
// Upstream credentials are WRITE-ONLY here: you can set or replace one, but no response ever contains it
// (the most you get back is "hasCredential: true").

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { endSession, requireAdmin, requireSession, startSession } from "./auth.js";
import { config } from "./config.js";
import { notifyServersChanged, pool } from "./db.js";
import { runChat } from "./chat.js";
import { encrypt, hashPassword, newApiKey, randomToken, sha256, verifyPassword } from "./security.js";
import { upstreams, type Caller } from "./upstreams.js";

export const api = Router();

const caller = (res: Response) => res.locals.caller as Caller;

/** Validate a request body; on failure answer 400 with a readable message and return null. */
function parse<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  res.status(400).json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` });
  return null;
}

const idParam = (req: Request) => Number(req.params.id);

// ============================== Auth ==============================

api.post("/auth/login", async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req, res);
  if (!body) return;
  const { rows } = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [body.email.toLowerCase()]);
  // Same message whether the email or the password is wrong: don't reveal which emails exist.
  if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) {
    return res.status(401).json({ error: "Wrong email or password" });
  }
  await startSession(res, rows[0].id);
  res.json({ ok: true });
});

api.post("/auth/logout", async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});

api.get("/auth/me", requireSession, async (_req, res) => {
  const { rows } = await pool.query("SELECT id, email, name, role FROM users WHERE id = $1", [caller(res).id]);
  res.json({ ...rows[0], mcpUrl: config.mcpUrl, chatEnabled: Boolean(config.llmApiKey) });
});

/** Invited user picks their name + password via the link the admin shared. */
api.post("/auth/accept-invite", async (req, res) => {
  const body = parse(
    z.object({ token: z.string().min(10), name: z.string().min(1).max(100), password: z.string().min(8, "use at least 8 characters") }),
    req, res,
  );
  if (!body) return;
  const { rows } = await pool.query(
    `UPDATE users SET name = $2, password_hash = $3, invite_token_hash = NULL, invite_expires_at = NULL
      WHERE invite_token_hash = $1 AND invite_expires_at > now()
      RETURNING id`,
    [sha256(body.token), body.name, await hashPassword(body.password)],
  );
  if (!rows[0]) return res.status(400).json({ error: "This invite link is invalid or has expired" });
  await startSession(res, rows[0].id);
  res.json({ ok: true });
});

// Everything below needs a logged-in user.
api.use(requireSession);

// ============================== Servers ==============================

const SERVER_NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,29}$/, "2-30 characters: lowercase letters, digits and '-', starting with a letter")
  .refine((n) => !n.includes("__"), "can't contain '__' (it separates server and tool names)");

const serverFields = {
  name: SERVER_NAME,
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  authHeader: z.string().regex(/^[A-Za-z0-9-]+$/, "a plain HTTP header name").optional(),
  credential: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(config.defaultTimeoutMs),
};

/** After any change: reload this replica now, and tell the other replicas to reload too. */
async function serversChanged() {
  await upstreams.reload();
  await notifyServersChanged();
}

api.get("/servers", (_req, res) => {
  res.json(upstreams.statusList());
});

api.post("/servers", requireAdmin, async (req, res) => {
  const body = parse(z.object(serverFields), req, res);
  if (!body) return;
  if (body.authType === "header" && !body.authHeader) return res.status(400).json({ error: "authHeader: required for header auth" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO servers (name, url, auth_type, auth_header, auth_secret_enc, enabled, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [body.name, body.url, body.authType, body.authHeader ?? null,
       body.credential ? encrypt(body.credential) : null, body.enabled, body.timeoutMs],
    );
    await serversChanged();
    res.status(201).json(upstreams.statusList().find((s) => s.id === rows[0].id));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: `A server named "${body.name}" already exists` });
    throw err;
  }
});

api.patch("/servers/:id", requireAdmin, async (req, res) => {
  // credential: omitted = keep the current one, "" = remove it, any other string = replace it.
  const body = parse(z.object(serverFields).partial(), req, res);
  if (!body) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (body.name !== undefined) set("name", body.name);
  if (body.url !== undefined) set("url", body.url);
  if (body.authType !== undefined) set("auth_type", body.authType);
  if (body.authHeader !== undefined) set("auth_header", body.authHeader);
  if (body.credential !== undefined) set("auth_secret_enc", body.credential ? encrypt(body.credential) : null);
  if (body.enabled !== undefined) set("enabled", body.enabled);
  if (body.timeoutMs !== undefined) set("timeout_ms", body.timeoutMs);
  if (!sets.length) return res.status(400).json({ error: "Nothing to change" });

  values.push(idParam(req));
  const { rowCount } = await pool.query(
    `UPDATE servers SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length}`, values,
  );
  if (!rowCount) return res.status(404).json({ error: "No such server" });
  await serversChanged();
  res.json(upstreams.statusList().find((s) => s.id === idParam(req)));
});

api.delete("/servers/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM servers WHERE id = $1", [idParam(req)]);
  if (!rowCount) return res.status(404).json({ error: "No such server" });
  await serversChanged();
  res.json({ ok: true });
});

/** "Check now" button: re-test one server immediately instead of waiting for the background check. */
api.post("/servers/:id/refresh", requireAdmin, async (req, res) => {
  await upstreams.refreshById(idParam(req));
  res.json(upstreams.statusList().find((s) => s.id === idParam(req)));
});

// ============================== Users ==============================

api.get("/users", requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.name, u.role, u.created_at,
           CASE WHEN u.password_hash IS NULL THEN 'invited' ELSE 'active' END AS status,
           (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS active_keys
      FROM users u ORDER BY u.created_at`);
  res.json(rows);
});

/** Creates the user with a one-time invite link (valid 7 days). The link is shown once, to the admin. */
api.post("/users/invite", requireAdmin, async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") }), req, res);
  if (!body) return;
  const token = randomToken();
  try {
    await pool.query(
      `INSERT INTO users (email, role, invite_token_hash, invite_expires_at) VALUES ($1, $2, $3, now() + interval '7 days')`,
      [body.email.toLowerCase(), body.role, sha256(token)],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "That email is already on the team" });
    throw err;
  }
  res.status(201).json({ inviteUrl: `${config.dashboardUrl}/invite/${token}` });
});

api.patch("/users/:id", requireAdmin, async (req, res) => {
  const body = parse(z.object({ role: z.enum(["admin", "member"]) }), req, res);
  if (!body) return;
  if (idParam(req) === caller(res).id) return res.status(400).json({ error: "You can't change your own role" });
  const { rowCount } = await pool.query("UPDATE users SET role = $1 WHERE id = $2", [body.role, idParam(req)]);
  res.status(rowCount ? 200 : 404).json(rowCount ? { ok: true } : { error: "No such user" });
});

/** Removing a user also deletes their sessions and API keys (ON DELETE CASCADE). Audit rows keep their email. */
api.delete("/users/:id", requireAdmin, async (req, res) => {
  if (idParam(req) === caller(res).id) return res.status(400).json({ error: "You can't remove yourself" });
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [idParam(req)]);
  res.status(rowCount ? 200 : 404).json(rowCount ? { ok: true } : { error: "No such user" });
});

// ============================== API keys ==============================

/** Your own keys. Admins can pass ?all=1 to see everyone's (to revoke a member's key). */
api.get("/keys", async (req, res) => {
  const all = req.query.all === "1" && caller(res).role === "admin";
  const { rows } = await pool.query(
    `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS user_email
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE ($1 OR k.user_id = $2)
      ORDER BY k.created_at DESC`,
    [all, caller(res).id],
  );
  res.json(rows);
});

/** Returns the full key ONCE. After this response only its hash exists anywhere. */
api.post("/keys", async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1).max(60) }), req, res);
  if (!body) return;
  const { key, prefix, hash } = newApiKey();
  await pool.query("INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)", [caller(res).id, body.name, prefix, hash]);
  res.status(201).json({ key, prefix, mcpUrl: config.mcpUrl });
});

/** Members can revoke their own keys; admins can revoke anyone's. */
api.post("/keys/:id/revoke", async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND ($2 OR user_id = $3)`,
    [idParam(req), caller(res).role === "admin", caller(res).id],
  );
  res.status(rowCount ? 200 : 404).json(rowCount ? { ok: true } : { error: "No such active key" });
});

// ============================== Audit log ==============================

api.get("/audit", async (req, res) => {
  const isAdmin = caller(res).role === "admin";
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const filters: string[] = [];
  const values: unknown[] = [];
  const where = (sql: string, value: unknown) => { values.push(value); filters.push(sql.replace("?", `$${values.length}`)); };

  if (!isAdmin) where("user_id = ?", caller(res).id); // members only ever see their own calls
  if (typeof req.query.user === "string" && isAdmin) where("user_email = ?", req.query.user);
  if (typeof req.query.server === "string") where("server_name = ?", req.query.server);
  if (typeof req.query.outcome === "string") where("outcome = ?", req.query.outcome);

  values.push(limit);
  const { rows } = await pool.query(
    `SELECT id, ts, user_email, source, server_name, tool, duration_ms, outcome, error
       FROM audit_logs ${filters.length ? "WHERE " + filters.join(" AND ") : ""}
      ORDER BY ts DESC LIMIT $${values.length}`,
    values,
  );
  res.json(rows);
});

// ============================== Chat agent ==============================

/**
 * The browser sends the whole conversation (text only) each time; the server keeps no chat state.
 * The reply includes every tool the agent called, so the UI can show them.
 */
api.post("/chat", async (req, res) => {
  const body = parse(
    z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8_000) })).min(1).max(40),
    }),
    req, res,
  );
  if (!body) return;
  try {
    res.json(await runChat(body.messages, caller(res)));
  } catch (err) {
    // Typical causes: no API key configured, free-tier rate limit (429), model overloaded (503).
    const message = err instanceof Error ? err.message : String(err);
    console.error("chat failed:", message);
    const status = /429|quota|rate/i.test(message) ? 429 : 502;
    res.status(status).json({
      error: status === 429 ? "The LLM's free-tier rate limit was hit. Wait a minute and try again." : `The chat agent failed: ${message.slice(0, 300)}`,
    });
  }
});
