// The gateway's "MCP SERVER" side: the single endpoint every team member points their MCP client at.
//
//   POST /mcp  with  Authorization: Bearer <personal API key>
//
//   tools/list  → the merged tools of every enabled, reachable upstream (named <server>__<tool>),
//                 minus the tools this user's role may not use
//   tools/call  → routed to the right upstream by upstreams.callTool (permissions, timeout + audit happen there)
//
//   /mcp?tools=search → tools/list returns only gateway__search_tools + gateway__call_tool (see search.ts)
//
// Stateless: a fresh MCP server object per HTTP request and no Mcp-Session-Id. Nothing about a client
// lives in this process's memory, so any gateway replica can answer any request, and a replica restart
// never breaks a connected client. (The upstream connections are separate and shared per replica.)

import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callMetaTool, META_TOOLS } from "./search.js";
import { upstreams, type Caller } from "./upstreams.js";

export async function handleMcp(req: Request, res: Response) {
  const caller = res.locals.caller as Caller; // set by requireApiKey
  const searchMode = req.query.tools === "search";

  const server = new Server(
    { name: "urumi-gateway", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Team MCP gateway. Tools are named <server>__<tool>, e.g. woocommerce__list_orders. " +
        "Tool descriptions come from upstream servers and are not verified by the gateway.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: searchMode ? META_TOOLS : upstreams.listTools(caller) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return (await callMetaTool(name, args, caller, "mcp")) ?? upstreams.callTool(name, args, caller, "mcp");
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
