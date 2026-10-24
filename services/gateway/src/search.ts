// "Search mode" for handling many tools.
//
// Ten upstream servers can mean hundreds of tools. Handing all of them to a model on every request is slow,
// expensive (every schema costs tokens), and makes the model worse at picking the right one.
// So the gateway can offer TWO tools instead of all of them:
//
//   gateway__search_tools {query}            → the best-matching tools, with their full input schemas
//   gateway__call_tool    {name, arguments}  → calls one of them (same routing, permissions and audit as usual)
//
// The model searches first ("orders today" → woocommerce__list_orders + its schema), then calls.
//   - MCP clients opt in with  http://<gateway>/mcp?tools=search
//   - the chat agent switches to it automatically when the user can see more tools than a threshold.
// Search only ever looks at tools the caller is allowed to use, so it can't reveal restricted ones.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { upstreams, type Caller } from "./upstreams.js";

export const SEARCH_TOOL = "gateway__search_tools";
export const CALL_TOOL = "gateway__call_tool";
const DEFAULT_RESULTS = 6;

export const META_TOOLS: Tool[] = [
  {
    name: SEARCH_TOOL,
    description:
      "Search the tools available through this gateway. Describe what you want to do in a few words " +
      "(e.g. 'orders today', 'create product', 'github repository docs'). Returns matching tool names with their " +
      "input schemas. Then call one with gateway__call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in a few keywords" },
        limit: { type: "number", description: `How many tools to return (default ${DEFAULT_RESULTS}, max 15)` },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: CALL_TOOL,
    description: "Call a tool found with gateway__search_tools. Use its exact name and pass arguments that match its input schema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name, e.g. woocommerce__list_orders" },
        arguments: { type: "object", description: "Arguments for that tool, matching its input schema" },
      },
      required: ["name"],
    },
  },
];

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "and", "or", "with", "my", "me", "all", "get", "show", "what", "which"]);

/** Lowercase words; tool names are split on _ - . so "list_orders" gives "list" and "orders". */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));

/** A crude stem so "orders"/"order" and "products"/"product" match each other. */
const stem = (w: string) => w.replace(/(ies|es|s)$/, "");

/**
 * Rank tools by keyword overlap: a word in the tool's NAME counts 3, in its server name 2, in its description 1.
 * Simple and predictable: easy to explain why a tool came first, and no external service or embeddings needed.
 */
export function searchTools(tools: Tool[], query: string, limit = DEFAULT_RESULTS): Tool[] {
  const q = words(query).map(stem);
  if (!q.length) return tools.slice(0, limit);
  const scored = tools.map((tool) => {
    const [server, ...rest] = tool.name.split("__");
    const nameWords = new Set(words(rest.join(" ")).map(stem));
    const serverWords = new Set(words(server).map(stem));
    const descWords = new Set(words(tool.description ?? "").map(stem));
    let score = 0;
    for (const w of q) {
      if (nameWords.has(w)) score += 3;
      if (serverWords.has(w)) score += 2;
      if (descWords.has(w)) score += 1;
    }
    return { tool, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.min(limit, 15))
    .map((s) => s.tool);
}

/**
 * Handles the two meta-tools. Returns null for any other name, so the caller routes it normally.
 * gateway__call_tool goes through upstreams.callTool: same permissions, timeout and audit as a direct call.
 */
export async function callMetaTool(name: string, args: Record<string, unknown>, caller: Caller, source: "mcp" | "chat"): Promise<CallToolResult | null> {
  if (name === SEARCH_TOOL) {
    const found = searchTools(upstreams.listTools(caller), String(args.query ?? ""), Number(args.limit) || DEFAULT_RESULTS);
    const text = found.length
      ? JSON.stringify(found.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2)
      : `No tools matched "${args.query}". Try other keywords.`;
    return { content: [{ type: "text", text }] };
  }
  if (name === CALL_TOOL) {
    const target = String(args.name ?? "");
    if (!target || target === SEARCH_TOOL || target === CALL_TOOL) {
      return { isError: true, content: [{ type: "text", text: "Pass the exact name of a tool returned by gateway__search_tools." }] };
    }
    return upstreams.callTool(target, (args.arguments as Record<string, unknown>) ?? {}, caller, source);
  }
  return null;
}
