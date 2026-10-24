// Who is calling? Two ways in, both ending with the same Caller {id, email, role} in res.locals.caller:
//
//   1. MCP clients (Claude Code, Cursor, Inspector):  "Authorization: Bearer mgw_..."  (a personal API key)
//   2. The dashboard (browser):                        an HttpOnly session cookie set at login
//
// Keys and session tokens are looked up by their SHA-256 hash, so the database never holds anything
// you could paste into a client. Revocation is checked on EVERY request (no caching), which is why
// a revoked key stops working on the very next call.

import type { NextFunction, Request, Response } from "express";
import { writeAudit } from "./audit.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { randomToken, sha256 } from "./security.js";
import { SEPARATOR, type Caller } from "./upstreams.js";

export const SESSION_COOKIE = "mgw_session";
const SESSION_DAYS = 7;

// ---------- 1. API keys (MCP endpoint) ----------

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const key = header.match(/^Bearer\s+(\S+)$/i)?.[1];

  const reject = (message: string) => {
    // WWW-Authenticate tells MCP clients this endpoint wants a bearer token.
    res.setHeader("WWW-Authenticate", 'Bearer realm="urumi-gateway"');
    res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } });
  };

  if (!key) return reject("Missing API key. Send it as: Authorization: Bearer <your key>");

  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.revoked_at, u.id, u.email, u.role
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  const row = rows[0];
  if (!row) return reject("Invalid API key");

  if (row.revoked_at) {
    // We still know whose key it was, so a blocked tool call is audited under that user.
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (body?.method === "tools/call") {
      const [server, ...tool] = (body.params?.name ?? "unknown").split(SEPARATOR);
      await writeAudit({
        userId: row.id, userEmail: row.email, source: "mcp", serverName: tool.length ? server : null,
        tool: tool.length ? tool.join(SEPARATOR) : server, durationMs: 0, outcome: "denied", error: "API key revoked",
      });
    }
    return reject("This API key has been revoked");
  }

  void pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.key_id]);
  res.locals.caller = { id: row.id, email: row.email, role: row.role } satisfies Caller;
  next();
}

// ---------- 2. Sessions (dashboard) ----------

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

/** Creates a session row and sets the cookie. The browser gets the token; the database keeps only its hash. */
export async function startSession(res: Response, userId: number) {
  const token = randomToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,                 // JavaScript in the page can't read it, so an XSS bug can't steal it
    sameSite: "strict",             // not sent on requests started by other websites (blocks CSRF)
    secure: config.secureCookies,   // HTTPS-only in production
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: "/",
  });
}

export async function endSession(req: Request, res: Response) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (rows[0]) {
      res.locals.caller = rows[0] satisfies Caller;
      return next();
    }
  }
  res.status(401).json({ error: "Not logged in" });
}

/** Use after requireSession: only admins may continue. The check lives here, on the server, not in the UI. */
export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if ((res.locals.caller as Caller).role !== "admin") return res.status(403).json({ error: "Admins only" });
  next();
}
