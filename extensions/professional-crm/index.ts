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

const server = new McpServer({ name: "professional-crm", version: "1.0.0" });

server.registerTool(
  "add_professional_contact",
  {
    title: "Add Professional Contact",
    description: "Add a new professional contact to your network",
    inputSchema: {
      name: z.string(),
      company: z.string().optional(),
      title: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      linkedin_url: z.string().optional(),
      how_we_met: z.string().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
  },
  async ({ name, company, title, email, phone, linkedin_url, how_we_met, tags, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO professional_contacts
          (user_id, name, company, title, email, phone, linkedin_url, how_we_met, tags, notes)
        VALUES (${DEFAULT_USER_ID}, ${name}, ${company ?? null}, ${title ?? null},
                ${email ?? null}, ${phone ?? null}, ${linkedin_url ?? null},
                ${how_we_met ?? null},
                ${tags ? sql.array(tags) : sql`'{}'::text[]`},
                ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, contact: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "search_contacts",
  {
    title: "Search Contacts",
    description: "Search professional contacts by name, company, or tags",
    inputSchema: {
      query: z.string().optional().describe("Searches name, company, title, notes"),
      tags: z.array(z.string()).optional().describe("All tags must match"),
    },
  },
  async ({ query, tags }) => {
    try {
      const rows = await sql`
        SELECT * FROM professional_contacts
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (${query ?? null} IS NULL OR (
                name    ILIKE ${"%" + (query ?? "") + "%"} OR
                company ILIKE ${"%" + (query ?? "") + "%"} OR
                title   ILIKE ${"%" + (query ?? "") + "%"} OR
                notes   ILIKE ${"%" + (query ?? "") + "%"}
              ))
          AND (${tags && tags.length ? sql.array(tags) : null}::text[] IS NULL
               OR ${tags && tags.length ? sql.array(tags) : sql`'{}'::text[]`} <@ tags)
        ORDER BY name ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: rows.length, contacts: rows }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "log_interaction",
  {
    title: "Log Interaction",
    description: "Log an interaction with a contact (automatically updates last_contacted via DB trigger)",
    inputSchema: {
      contact_id: z.string().describe("Contact ID (UUID)"),
      interaction_type: z.enum(["meeting", "email", "call", "coffee", "event", "linkedin", "other"]),
      occurred_at: z.string().optional().describe("ISO 8601 timestamp (defaults to now)"),
      summary: z.string(),
      follow_up_needed: z.boolean().optional(),
      follow_up_notes: z.string().optional(),
    },
  },
  async ({ contact_id, interaction_type, occurred_at, summary, follow_up_needed, follow_up_notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO contact_interactions
          (user_id, contact_id, interaction_type, occurred_at, summary, follow_up_needed, follow_up_notes)
        VALUES (${DEFAULT_USER_ID}, ${contact_id}, ${interaction_type},
                ${occurred_at ?? null}, ${summary},
                ${follow_up_needed ?? false}, ${follow_up_notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, interaction: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_contact_history",
  {
    title: "Get Contact History",
    description: "Get a contact's full profile, interactions, and opportunities",
    inputSchema: { contact_id: z.string().describe("Contact ID (UUID)") },
  },
  async ({ contact_id }) => {
    try {
      const [contact] = await sql`
        SELECT * FROM professional_contacts WHERE id = ${contact_id} AND user_id = ${DEFAULT_USER_ID}
      `;
      if (!contact) throw new Error("Contact not found");
      const interactions = await sql`
        SELECT * FROM contact_interactions
        WHERE contact_id = ${contact_id} AND user_id = ${DEFAULT_USER_ID}
        ORDER BY occurred_at DESC
      `;
      const opportunities = await sql`
        SELECT * FROM opportunities
        WHERE contact_id = ${contact_id} AND user_id = ${DEFAULT_USER_ID}
        ORDER BY created_at DESC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, contact, interactions, opportunities }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "create_opportunity",
  {
    title: "Create Opportunity",
    description: "Create a new opportunity/deal, optionally linked to a contact",
    inputSchema: {
      contact_id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      stage: z.enum(["identified", "in_conversation", "proposal", "negotiation", "won", "lost"]).optional(),
      value: z.number().optional(),
      expected_close_date: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
  },
  async ({ contact_id, title, description, stage, value, expected_close_date, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO opportunities
          (user_id, contact_id, title, description, stage, value, expected_close_date, notes)
        VALUES (${DEFAULT_USER_ID}, ${contact_id ?? null}, ${title}, ${description ?? null},
                ${stage ?? "identified"}, ${value ?? null},
                ${expected_close_date ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, opportunity: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_follow_ups_due",
  {
    title: "Get Follow-ups Due",
    description: "List contacts with follow-ups due in the next N days",
    inputSchema: { days_ahead: z.number().optional().describe("Days to look ahead (default 7)") },
  },
  async ({ days_ahead = 7 }) => {
    try {
      const futureDateStr = new Date(Date.now() + days_ahead * 86400000).toISOString().split("T")[0];
      const todayStr = new Date().toISOString().split("T")[0];
      const rows = await sql`
        SELECT * FROM professional_contacts
        WHERE user_id = ${DEFAULT_USER_ID}
          AND follow_up_date IS NOT NULL
          AND follow_up_date <= ${futureDateStr}::date
        ORDER BY follow_up_date ASC
      `;
      const overdue  = rows.filter((c) => (c.follow_up_date as string) < todayStr);
      const upcoming = rows.filter((c) => (c.follow_up_date as string) >= todayStr);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, overdue_count: overdue.length, upcoming_count: upcoming.length, overdue, upcoming }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "link_thought_to_contact",
  {
    title: "Link Thought to Contact",
    description: "CROSS-EXTENSION: Append a thought from the core Open Brain to a contact's notes",
    inputSchema: {
      thought_id: z.string().describe("Thought ID (UUID) from core thoughts table"),
      contact_id: z.string().describe("Contact ID (UUID)"),
    },
  },
  async ({ thought_id, contact_id }) => {
    try {
      const [thought] = await sql`SELECT * FROM thoughts WHERE id = ${thought_id}`;
      if (!thought) throw new Error("Thought not found");
      const [contact] = await sql`SELECT * FROM professional_contacts WHERE id = ${contact_id} AND user_id = ${DEFAULT_USER_ID}`;
      if (!contact) throw new Error("Contact not found");
      const linkNote = `\n\n[Linked Thought ${new Date().toISOString().split("T")[0]}]: ${thought.content}`;
      const [updated] = await sql`
        UPDATE professional_contacts
        SET notes = COALESCE(notes, '') || ${linkNote}
        WHERE id = ${contact_id} AND user_id = ${DEFAULT_USER_ID}
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, contact: updated }, null, 2) }] };
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
app.get("*", (c) => c.json({ status: "ok", service: "Professional CRM", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3005") }, app.fetch);
