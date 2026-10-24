// Tool permissions: which role may use which tool.
//
// DEFAULT (no admin override): taken from the tool's own MCP annotations.
//   - a tool that says it writes (readOnlyHint: false) or destroys (destructiveHint: true)  → admins only
//   - everything else (read-only, or no annotations at all)                                   → members too
//   So with our WooCommerce server: members may list products/orders and get an order; only admins may
//   create products or change an order's status.
//
// OVERRIDE: an admin can flip any single tool in the dashboard (stored in the tool_policies table).
//
// ENFORCED in the gateway, for every path (MCP clients and the chat agent):
//   - tools/list only returns tools the caller may use (restricted tools are hidden)
//   - tools/call of a restricted tool is rejected and audited as "denied", even if the client knows its name

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type Role = "member" | "admin";

/** The role a tool needs when no admin has overridden it. */
export function defaultRole(tool: Tool): Role {
  const a = tool.annotations;
  return a?.readOnlyHint === false || a?.destructiveHint === true ? "admin" : "member";
}

/** Can someone with this role use a tool that needs `required`? Admins can use everything. */
export const roleAllows = (role: Role, required: Role) => role === "admin" || required === "member";
