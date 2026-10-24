// The upstream manager: the gateway's "MCP CLIENT" side.
//
// For every registered server it keeps:
//   - an MCP client connection (initialize handshake done once, then reused)
//   - the cached tool list
//   - a status: connected | unreachable | disabled, plus the last error in plain words
//
// HOW TOOLS ARE NAMED (collision scheme)
//   Every tool is exposed as  <server name>__<tool name>,  e.g.  woocommerce__list_orders.
//   Server names are unique and can't contain "__", so the first "__" always splits a name unambiguously,
//   and two servers can both have an "echo" tool (everything__echo vs other__echo) without clashing.
//   Exposed names must fit what LLM APIs accept: letters, digits, "_" and "-", at most 64 characters.
//   Tools that don't fit are skipped (and reported on the server's card in the dashboard), not renamed silently.
//
// FAILURE HANDLING
//   - Every network step (connect, list, call) has a timeout (per server, default 15s).
//   - Servers are checked in parallel and independently: one slow or dead server never delays the others.
//   - A dead server is marked "unreachable", its tools vanish from tools/list, and calls to them get a
//     clear error immediately instead of hanging. A background check every 15s brings it back when it recovers.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeAudit } from "./audit.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { decrypt } from "./security.js";

export const SEPARATOR = "__";
const MAX_EXPOSED_NAME = 64;
const VALID_EXPOSED_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_DESCRIPTION = 1024; // long descriptions are cut: they cost tokens and are a favourite place to hide prompt injection

export type ServerRow = {
  id: number;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header: string | null;
  auth_secret_enc: string | null;
  enabled: boolean;
  timeout_ms: number;
  created_at: Date;
  updated_at: Date;
};

export type Status = "connected" | "unreachable" | "disabled";

/** Who is calling. Every call is attributed to a real user, whether it came from an MCP client or the chat. */
export type Caller = { id: number; email: string; role: "admin" | "member" };

type Upstream = {
  row: ServerRow;
  status: Status;
  error: string | null;
  checkedAt: Date | null;
  tools: Tool[];
  skippedTools: string[];
  client: Client | null;
  refreshing?: Promise<void>;
};

/** Turns any error into one readable sentence (no stack traces, no secrets). */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") return "connection refused (is the server running?)";
  if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") return "host name could not be resolved";
  if (cause?.code === "ECONNRESET") return "connection was reset by the server";
  if (/timed out/i.test(err.message)) return "no answer before the timeout";
  if (/fetch failed/i.test(err.message)) return `network error${cause?.code ? ` (${cause.code})` : ""}`;
  return err.message.slice(0, 300);
}

/** Runs a promise but gives up after ms milliseconds (used where the SDK has no timeout option). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms).unref()),
  ]);
}

class UpstreamManager {
  private upstreams = new Map<number, Upstream>();

  /** Load servers from the database, connect to all of them, then keep re-checking in the background. */
  async start() {
    await this.reload();
    setInterval(() => void this.refreshAll(), config.refreshIntervalMs).unref();
  }

  /**
   * Re-read the servers table. New servers get added, deleted ones get disconnected,
   * and edited ones (updated_at changed) get a fresh connection with their new URL/credential.
   */
  async reload() {
    const { rows } = await pool.query<ServerRow>("SELECT * FROM servers ORDER BY name");
    const ids = new Set(rows.map((r) => r.id));

    for (const [id, up] of this.upstreams) {
      if (!ids.has(id)) {
        await this.disconnect(up);
        this.upstreams.delete(id);
      }
    }
    for (const row of rows) {
      const existing = this.upstreams.get(row.id);
      if (existing && existing.row.updated_at.getTime() === row.updated_at.getTime()) continue;
      if (existing) await this.disconnect(existing);
      this.upstreams.set(row.id, {
        row,
        status: row.enabled ? "unreachable" : "disabled",
        error: row.enabled ? "not checked yet" : null,
        checkedAt: null,
        tools: [],
        skippedTools: [],
        client: null,
      });
    }
    await this.refreshAll();
  }

  /** Check every server in parallel. allSettled = one failure never stops the others. */
  async refreshAll() {
    await Promise.allSettled([...this.upstreams.values()].map((up) => this.refresh(up)));
  }

  async refreshById(id: number) {
    const up = this.upstreams.get(id);
    if (up) await this.refresh(up);
  }

  private refresh(up: Upstream): Promise<void> {
    // If a check is already running for this server, wait for that one instead of starting a second.
    up.refreshing ??= this.doRefresh(up).finally(() => (up.refreshing = undefined));
    return up.refreshing;
  }

  private async doRefresh(up: Upstream) {
    if (!up.row.enabled) {
      await this.disconnect(up);
      Object.assign(up, { status: "disabled", error: null, tools: [], skippedTools: [], checkedAt: new Date() });
      return;
    }
    try {
      try {
        up.client ??= await this.connect(up.row);
        await this.loadTools(up);
      } catch (firstErr) {
        // The upstream may simply have restarted and forgotten our session: retry once with a fresh connection.
        if (!up.client) throw firstErr;
        await this.disconnect(up);
        up.client = await this.connect(up.row);
        await this.loadTools(up);
      }
      up.status = "connected";
      up.error = null;
    } catch (err) {
      await this.disconnect(up);
      Object.assign(up, { status: "unreachable", error: describe(err), tools: [], skippedTools: [] });
    } finally {
      up.checkedAt = new Date();
    }
  }

  /** Open an MCP connection: HTTP POST "initialize", then the "initialized" notification. */
  private async connect(row: ServerRow): Promise<Client> {
    // The upstream credential is decrypted ONLY here, in memory, right before it's attached to outbound requests.
    // It is never sent to browsers or MCP clients, and the caller's own API key is never forwarded upstream.
    const headers: Record<string, string> = {};
    if (row.auth_type !== "none" && row.auth_secret_enc) {
      const secret = decrypt(row.auth_secret_enc);
      if (row.auth_type === "bearer") headers.Authorization = `Bearer ${secret}`;
      else if (row.auth_header) headers[row.auth_header] = secret;
    }
    const transport = new StreamableHTTPClientTransport(new URL(row.url), { requestInit: { headers } });
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    await client.connect(transport, { timeout: row.timeout_ms });
    return client;
  }

  /** tools/list (following pagination), then keep only tools whose exposed name is valid. */
  private async loadTools(up: Upstream) {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await up.client!.listTools(cursor ? { cursor } : undefined, { timeout: up.row.timeout_ms });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    up.tools = [];
    up.skippedTools = [];
    for (const tool of tools) {
      const exposed = `${up.row.name}${SEPARATOR}${tool.name}`;
      if (exposed.length <= MAX_EXPOSED_NAME && VALID_EXPOSED_NAME.test(exposed)) up.tools.push(tool);
      else up.skippedTools.push(tool.name);
    }
  }

  private async disconnect(up: Upstream) {
    const client = up.client;
    up.client = null;
    if (client) await withTimeout(client.close(), 2_000).catch(() => {});
  }

  // ---------- What MCP clients and the chat agent see ----------

  /** The merged tool list: every tool of every enabled + connected server, under its prefixed name. */
  listTools(): Tool[] {
    const all: Tool[] = [];
    for (const up of this.upstreams.values()) {
      if (up.status !== "connected") continue;
      for (const tool of up.tools) {
        const description = (tool.description ?? "").slice(0, MAX_DESCRIPTION);
        all.push({ ...tool, name: `${up.row.name}${SEPARATOR}${tool.name}`, description: `[${up.row.name}] ${description}` });
      }
    }
    return all;
  }

  /**
   * Route one tool call to the right upstream, with a timeout, and audit it.
   * Never throws: every failure becomes a tool error with a clear message, so the caller (or model) can react.
   */
  async callTool(exposedName: string, args: Record<string, unknown>, caller: Caller, source: "mcp" | "chat"): Promise<CallToolResult> {
    const started = Date.now();
    const split = exposedName.indexOf(SEPARATOR);
    const serverName = split > 0 ? exposedName.slice(0, split) : null;
    const toolName = split > 0 ? exposedName.slice(split + SEPARATOR.length) : exposedName;
    const up = [...this.upstreams.values()].find((u) => u.row.name === serverName);

    const audit = (outcome: "success" | "tool_error" | "error", error?: string) =>
      writeAudit({
        userId: caller.id, userEmail: caller.email, source,
        serverName: up?.row.name ?? serverName, tool: toolName,
        durationMs: Date.now() - started, outcome, error,
      });
    const fail = async (message: string): Promise<CallToolResult> => {
      await audit("error", message);
      return { isError: true, content: [{ type: "text", text: message }] };
    };

    if (!up) return fail(`Unknown tool "${exposedName}". Tools are named <server>${SEPARATOR}<tool>; list tools to see what is available.`);
    if (!up.row.enabled) return fail(`The "${up.row.name}" server is disabled by an admin, so its tools can't be used.`);
    if (up.status !== "connected" || !up.client) return fail(`The "${up.row.name}" server is unreachable right now (${up.error ?? "unknown error"}).`);
    if (!up.tools.some((t) => t.name === toolName)) return fail(`The "${up.row.name}" server has no tool called "${toolName}".`);

    try {
      // The SDK sends a cancel notification upstream if the timeout fires, then raises an error here.
      const result = (await up.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: up.row.timeout_ms })) as CallToolResult;
      if (result.isError) {
        const text = result.content?.find((c) => c.type === "text");
        await audit("tool_error", text && "text" in text ? text.text : "tool reported an error");
      } else {
        await audit("success");
      }
      return result;
    } catch (err) {
      const reason = describe(err);
      if (reason !== "no answer before the timeout") {
        // The connection itself failed (not just a slow tool): mark it unreachable now, don't wait for the next check.
        await this.disconnect(up);
        Object.assign(up, { status: "unreachable", error: reason, tools: [], checkedAt: new Date() });
        void this.refresh(up);
      }
      const message =
        reason === "no answer before the timeout"
          ? `"${exposedName}" did not answer within ${up.row.timeout_ms / 1000}s, so the call was cancelled.`
          : `Calling "${exposedName}" failed: ${reason}.`;
      return fail(message);
    }
  }

  // ---------- What the dashboard sees (never includes credentials) ----------

  statusList() {
    return [...this.upstreams.values()]
      .sort((a, b) => a.row.name.localeCompare(b.row.name))
      .map((up) => ({
        id: up.row.id,
        name: up.row.name,
        url: up.row.url,
        authType: up.row.auth_type,
        authHeader: up.row.auth_header,
        hasCredential: Boolean(up.row.auth_secret_enc),
        enabled: up.row.enabled,
        timeoutMs: up.row.timeout_ms,
        status: up.status,
        error: up.error,
        checkedAt: up.checkedAt,
        skippedTools: up.skippedTools,
        tools: up.tools.map((t) => ({ name: `${up.row.name}${SEPARATOR}${t.name}`, description: t.description ?? "" })),
      }));
  }
}

export const upstreams = new UpstreamManager();
