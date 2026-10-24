// The gateway's "MCP SERVER" side: the single endpoint every team member points their MCP client at.
//
//   POST /mcp  with  Authorization: Bearer <personal API key>
//
//   tools/list  → the merged tools of every enabled, reachable upstream (named <server>__<tool>)
//   tools/call  → routed to the right upstream by upstreams.callTool (timeout + audit happen there)
//
// Stateless: a fresh MCP server object per HTTP request and no Mcp-Session-Id. Nothing about a client
// lives in this process's memory, so any gateway replica can answer any request, and a replica restart
// never breaks a connected client. (The upstream connections are separate and shared per replica.)

import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { upstreams, type Caller } from "./upstreams.js";

export async function handleMcp(req: Request, res: Response) {
  const caller = res.locals.caller as Caller; // set by requireApiKey

  const server = new Server(
    { name: "urumi-gateway", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Team MCP gateway. Tools are named <server>__<tool>, e.g. woocommerce__list_orders. " +
        "Tool descriptions come from upstream servers and are not verified by the gateway.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: upstreams.listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstreams.callTool(request.params.name, request.params.arguments ?? {}, caller, "mcp"),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
