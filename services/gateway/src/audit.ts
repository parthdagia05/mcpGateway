// The audit log: one row per tool call, from EVERY path (external MCP clients and the chat agent both
// go through upstreams.callTool, which is the only place that writes here). That single choke point is
// what guarantees "every call appears in the audit log, attributed to the right user".

import { pool } from "./db.js";

export type AuditOutcome =
  | "success"     // the tool ran and returned a normal result
  | "tool_error"  // the tool ran but reported a failure (isError: true), e.g. "order not found"
  | "error"       // we couldn't complete the call: upstream down, timeout, unknown tool, disabled server
  | "denied";     // rejected before reaching any upstream, e.g. a revoked API key

export type AuditEntry = {
  userId: number | null;
  userEmail: string | null;
  source: "mcp" | "chat";
  serverName: string | null;
  tool: string;
  durationMs: number | null;
  outcome: AuditOutcome;
  error?: string;
};

export async function writeAudit(e: AuditEntry) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_email, source, server_name, tool, duration_ms, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.userId, e.userEmail, e.source, e.serverName, e.tool, e.durationMs, e.outcome, e.error?.slice(0, 1000) ?? null],
    );
  } catch (err) {
    // Never fail the user's call because the audit insert failed, but make it loud in the logs.
    console.error("AUDIT WRITE FAILED", e, err);
  }
}
