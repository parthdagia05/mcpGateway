// WooCommerce MCP server: entry point.
//
// Speaks MCP over Streamable HTTP on ONE endpoint: POST /mcp (JSON-RPC: initialize, tools/list, tools/call).
// It runs STATELESS: every HTTP request gets a fresh MCP server + transport, and no Mcp-Session-Id is issued.
// That's fine here because our tools don't need memory between calls, and it means any replica can
// answer any request (no sticky sessions needed behind the Service).
//
// Who can call this? Only the gateway. That's enforced by Kubernetes, not by this code:
// the Service is ClusterIP (no Ingress = not reachable from outside), and a NetworkPolicy
// only lets Pods labelled app=gateway in.
//
// Also serves GET /healthz for the Kubernetes liveness/readiness probes.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";

const MAX_BODY_BYTES = 1_000_000; // refuse absurdly large requests instead of buffering them

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/**
 * True if the request carries the right bearer token (or no token is configured).
 * Both sides are hashed first so timingSafeEqual gets equal-length inputs, and the comparison takes
 * the same time whether the guess is close or not (no timing hints for an attacker).
 */
function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.authToken) return true;
  const sent = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(sent), hash(config.authToken));
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: missing or wrong bearer token" } });
  }

  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // JSON-RPC "parse error": the request wasn't valid JSON.
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } });
    }
  }

  // Fresh server + transport per request (stateless mode).
  const server = new McpServer({ name: "woocommerce", version: "0.1.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Clean up once the response is finished (or the client hangs up).
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") return sendJson(res, 200, { ok: true });

  if (path === "/mcp") {
    handleMcp(req, res).catch((err) => {
      console.error("MCP request failed:", err);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
    });
    return;
  }

  sendJson(res, 404, { error: "Not found. The MCP endpoint is POST /mcp" });
});

httpServer.listen(config.port, () => {
  console.log(`woo-mcp listening on :${config.port}/mcp → store ${config.storeUrl} (timezone ${config.timezone})`);
});

// Kubernetes sends SIGTERM before stopping a Pod: stop accepting new connections and exit cleanly.
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});
