import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import postgres from "npm:postgres@3.4.5";
import { authMiddleware } from "../../lib/auth.ts";

const sql = postgres(
  Deno.env.get("DATABASE_URL") ??
    "postgresql://openbrain:changeme@localhost:5432/openbrain"
);
const DEFAULT_USER_ID = Deno.env.get("DEFAULT_USER_ID") ?? "default";

const server = new McpServer({ name: "household-knowledge", version: "1.0.0" });

server.registerTool(
  "add_household_item",
  {
    title: "Add Household Item",
    description: "Add a new household item (paint color, appliance, measurement, document, etc.)",
    inputSchema: {
      name: z.string().describe("Name or description of the item"),
      category: z.string().optional().describe("Category (e.g. 'paint', 'appliance', 'measurement')"),
      location: z.string().optional().describe("Location in the home (e.g. 'Living Room', 'Kitchen')"),
      details: z.string().optional().describe("Flexible metadata as JSON string"),
      notes: z.string().optional(),
    },
  },
  async ({ name, category, location, details, notes }) => {
    try {
      let detailsJson: Record<string, unknown> = {};
      if (details) { try { detailsJson = JSON.parse(details); } catch { /* keep empty */ } }
      const [row] = await sql`
        INSERT INTO household_items (user_id, name, category, location, details, notes)
        VALUES (${DEFAULT_USER_ID}, ${name}, ${category ?? null}, ${location ?? null},
                ${JSON.stringify(detailsJson)}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, item: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "search_household_items",
  {
    title: "Search Household Items",
    description: "Search household items by name, category, or location",
    inputSchema: {
      query: z.string().optional().describe("Search term (name, category, location, notes)"),
      category: z.string().optional(),
      location: z.string().optional(),
    },
  },
  async ({ query, category, location }) => {
    try {
      const rows = await sql`
        SELECT * FROM household_items
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (${category ?? null} IS NULL OR category ILIKE ${"%" + (category ?? "") + "%"})
          AND (${location ?? null} IS NULL OR location ILIKE ${"%" + (location ?? "") + "%"})
          AND (${query ?? null} IS NULL OR (
                name     ILIKE ${"%" + (query ?? "") + "%"} OR
                category ILIKE ${"%" + (query ?? "") + "%"} OR
                location ILIKE ${"%" + (query ?? "") + "%"} OR
                notes    ILIKE ${"%" + (query ?? "") + "%"}
              ))
        ORDER BY created_at DESC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: rows.length, items: rows }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_item_details",
  {
    title: "Get Item Details",
    description: "Get full details of a specific household item by ID",
    inputSchema: { item_id: z.string().describe("Item ID (UUID)") },
  },
  async ({ item_id }) => {
    try {
      const [row] = await sql`SELECT * FROM household_items WHERE id = ${item_id} AND user_id = ${DEFAULT_USER_ID}`;
      if (!row) throw new Error("Item not found");
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, item: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "add_vendor",
  {
    title: "Add Vendor",
    description: "Add a service provider (plumber, electrician, landscaper, etc.)",
    inputSchema: {
      name: z.string(),
      service_type: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      notes: z.string().optional(),
      rating: z.number().min(1).max(5).optional(),
      last_used: z.string().optional().describe("YYYY-MM-DD"),
    },
  },
  async ({ name, service_type, phone, email, website, notes, rating, last_used }) => {
    try {
      const [row] = await sql`
        INSERT INTO household_vendors (user_id, name, service_type, phone, email, website, notes, rating, last_used)
        VALUES (${DEFAULT_USER_ID}, ${name}, ${service_type ?? null}, ${phone ?? null},
                ${email ?? null}, ${website ?? null}, ${notes ?? null},
                ${rating ?? null}, ${last_used ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, vendor: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "list_vendors",
  {
    title: "List Vendors",
    description: "List service providers, optionally filtered by service type",
    inputSchema: { service_type: z.string().optional() },
  },
  async ({ service_type }) => {
    try {
      const rows = await sql`
        SELECT * FROM household_vendors
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (${service_type ?? null} IS NULL OR service_type ILIKE ${"%" + (service_type ?? "") + "%"})
        ORDER BY name ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: rows.length, vendors: rows }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};
const app = new Hono();
app.options("*", (c) => c.text("ok", 200, corsHeaders));
app.use("*", authMiddleware);
app.post("*", async (c) => {
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method, headers, body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});
app.get("*", (c) => c.json({ status: "ok", service: "Household Knowledge MCP", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3001") }, app.fetch);
