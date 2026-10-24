// The five tools this MCP server exposes. Each one = a name, a description the model reads,
// an input schema (zod → JSON Schema in tools/list), and a handler that calls WooCommerce.
//
// Results are returned as trimmed-down JSON text: only the fields a person or model actually needs,
// so a tools/call answer stays small and readable.
//
// Errors: if WooCommerce says no (bad ID, invalid status, store down), we return a TOOL error
// (isError: true + a readable message) rather than crashing, so the model can read it and recover.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { woo, WooError } from "./woo.js";

// ---------- Shapes of the WooCommerce objects we read (only the fields we use) ----------
type Product = {
  id: number; name: string; status: string; price: string; regular_price: string;
  stock_status: string; permalink: string; date_created: string;
};
type LineItem = { name: string; quantity: number; total: string; product_id: number };
type Order = {
  id: number; number: string; status: string; currency: string; total: string;
  date_created: string; payment_method_title: string; customer_note: string;
  billing: { first_name: string; last_name: string; email: string; phone: string; city: string };
  line_items: LineItem[];
};

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// ---------- Helpers ----------

/** Runs a handler and converts the outcome into an MCP tool result. */
async function run(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof WooError ? err.message : `Unexpected error: ${String(err)}`;
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

const productSummary = (p: Product) => ({
  id: p.id, name: p.name, price: p.price, regular_price: p.regular_price,
  status: p.status, stock_status: p.stock_status, url: p.permalink,
});

const orderSummary = (o: Order) => ({
  id: o.id, status: o.status, total: `${o.total} ${o.currency}`, created: o.date_created,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(), email: o.billing.email,
  items: o.line_items.map((i) => `${i.quantity} × ${i.name}`),
});

/** Minutes the given timezone is ahead of UTC at a given instant (e.g. Asia/Kolkata → 330). */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Midnight at the start of "today minus daysAgo" in the store's timezone, as a UTC Date. */
function startOfDay(daysAgo: number): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(new Date()).split("-").map(Number);
  const midnightAsIfUtc = new Date(Date.UTC(y, m - 1, d - daysAgo));
  return new Date(midnightAsIfUtc.getTime() - tzOffsetMinutes(midnightAsIfUtc, config.timezone) * 60_000);
}

// ---------- Tools ----------

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Optionally search by name.",
      inputSchema: {
        search: z.string().optional().describe("Only products whose name or description contains this text"),
        per_page: z.number().int().min(1).max(50).default(20).describe("How many products to return (max 50)"),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    ({ search, per_page, page }) =>
      run(async () => {
        const products = await woo<Product[]>("GET", "/products", { search, per_page, page, orderby: "date", order: "desc" });
        return products.map(productSummary);
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Create a simple product with a name and price. It is published on the storefront immediately unless status is 'draft'.",
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        price: z.number().positive().describe("Regular price in the store currency"),
        description: z.string().optional().describe("Optional product description (plain text or HTML)"),
        status: z.enum(["publish", "draft"]).default("publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, price, description, status }) =>
      run(async () => {
        const product = await woo<Product>("POST", "/products", {}, {
          name, type: "simple", status, regular_price: price.toFixed(2), description,
        });
        return productSummary(product);
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Use period='today' for orders that came in today (in the store's timezone). " +
        "Can also filter by status, or by an exact after/before date-time.",
      inputSchema: {
        period: z.enum(["today", "yesterday", "last_7_days", "last_30_days"]).optional()
          .describe("Shortcut for a date range in the store's timezone"),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any"),
        after: z.string().optional().describe("ISO 8601 date-time; only orders created after this"),
        before: z.string().optional().describe("ISO 8601 date-time; only orders created before this"),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    ({ period, status, after, before, per_page, page }) =>
      run(async () => {
        // Turn the period shortcut into exact UTC timestamps (WooCommerce takes them with dates_are_gmt=true).
        if (period === "today") after = startOfDay(0).toISOString();
        if (period === "yesterday") { after = startOfDay(1).toISOString(); before = startOfDay(0).toISOString(); }
        if (period === "last_7_days") after = startOfDay(6).toISOString();
        if (period === "last_30_days") after = startOfDay(29).toISOString();

        const orders = await woo<Order[]>("GET", "/orders", {
          status, after, before, per_page, page, dates_are_gmt: after || before ? true : undefined,
          orderby: "date", order: "desc",
        });
        return { timezone: config.timezone, after, before, count: orders.length, orders: orders.map(orderSummary) };
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get the full details of one order by its ID: items, totals, customer, payment method and status.",
      inputSchema: { id: z.number().int().positive().describe("Order ID") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const o = await woo<Order>("GET", `/orders/${id}`);
        return {
          ...orderSummary(o),
          payment_method: o.payment_method_title,
          customer_note: o.customer_note || undefined,
          phone: o.billing.phone,
          city: o.billing.city,
          line_items: o.line_items.map((i) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })),
        };
      }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change an order's status, e.g. mark it 'completed' or 'cancelled'. Returns the previous and new status.",
      inputSchema: {
        id: z.number().int().positive().describe("Order ID"),
        status: z.enum(ORDER_STATUSES).describe("New status"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id, status }) =>
      run(async () => {
        // Read first so the answer (and the audit trail) shows what it changed from.
        const before = await woo<Order>("GET", `/orders/${id}`);
        const after = await woo<Order>("PUT", `/orders/${id}`, {}, { status });
        return { id, previous_status: before.status, status: after.status };
      }),
  );
}
