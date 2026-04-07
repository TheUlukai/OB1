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

const server = new McpServer({ name: "family-calendar", version: "1.0.0" });

server.registerTool(
  "add_family_member",
  {
    title: "Add Family Member",
    description: "Add a person to your household roster",
    inputSchema: {
      name: z.string(),
      relationship: z.string().optional().describe("e.g. 'spouse', 'child', 'parent'"),
      birthday: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
  },
  async ({ name, relationship, birthday, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO family_members (user_id, name, relationship, birthday, notes)
        VALUES (${DEFAULT_USER_ID}, ${name}, ${relationship ?? null}, ${birthday ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "add_activity",
  {
    title: "Add Activity",
    description: "Add a family activity or event",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      member_ids: z.array(z.string()).optional().describe("Family member UUIDs. Empty = whole family."),
      start_time: z.string().optional().describe("ISO 8601 datetime"),
      end_time: z.string().optional().describe("ISO 8601 datetime"),
      location: z.string().optional(),
      recurring: z.string().optional().describe("e.g. 'weekly', 'every Monday at 3pm'"),
      notes: z.string().optional(),
    },
  },
  async ({ title, description, member_ids, start_time, end_time, location, recurring, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO family_activities (user_id, title, description, member_ids, start_time, end_time, location, recurring, notes)
        VALUES (${DEFAULT_USER_ID}, ${title}, ${description ?? null},
                ${member_ids ? sql.array(member_ids) : null}::uuid[],
                ${start_time ?? null}, ${end_time ?? null},
                ${location ?? null}, ${recurring ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_week_schedule",
  {
    title: "Get Week Schedule",
    description: "Get all activities for a given week",
    inputSchema: {
      week_start: z.string().describe("Start of the week (YYYY-MM-DD)"),
      member_id: z.string().optional().describe("Filter by family member UUID"),
    },
  },
  async ({ week_start, member_id }) => {
    try {
      const weekEnd = new Date(week_start);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekEndStr = weekEnd.toISOString().split("T")[0];
      const rows = await sql`
        SELECT * FROM family_activities
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (
            (start_time >= ${week_start}::timestamptz AND start_time < ${weekEndStr}::timestamptz)
            OR recurring IS NOT NULL
          )
          AND (${member_id ?? null} IS NULL OR ${member_id ?? null}::uuid = ANY(member_ids))
        ORDER BY start_time ASC NULLS LAST
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "search_activities",
  {
    title: "Search Activities",
    description: "Search activities by title or description",
    inputSchema: {
      query: z.string().optional(),
      member_id: z.string().optional().describe("Filter by family member UUID"),
    },
  },
  async ({ query, member_id }) => {
    try {
      const rows = await sql`
        SELECT * FROM family_activities
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (${query ?? null} IS NULL OR (
                title ILIKE ${"%" + (query ?? "") + "%"} OR
                description ILIKE ${"%" + (query ?? "") + "%"}
              ))
          AND (${member_id ?? null} IS NULL OR ${member_id ?? null}::uuid = ANY(member_ids))
        ORDER BY start_time DESC NULLS LAST
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "add_important_date",
  {
    title: "Add Important Date",
    description: "Add a date to remember (birthday, anniversary, deadline)",
    inputSchema: {
      title: z.string(),
      date: z.string().describe("YYYY-MM-DD"),
      member_ids: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
  },
  async ({ title, date, member_ids, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO important_dates (user_id, title, date, member_ids, notes)
        VALUES (${DEFAULT_USER_ID}, ${title}, ${date}::date,
                ${member_ids ? sql.array(member_ids) : null}::uuid[],
                ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_upcoming_dates",
  {
    title: "Get Upcoming Dates",
    description: "Get important dates in the next N days",
    inputSchema: { days_ahead: z.number().optional().describe("Days to look ahead (default 30)") },
  },
  async ({ days_ahead = 30 }) => {
    try {
      const rows = await sql`
        SELECT * FROM important_dates
        WHERE user_id = ${DEFAULT_USER_ID}
          AND date >= CURRENT_DATE
          AND date <= (CURRENT_DATE + ${days_ahead} * INTERVAL '1 day')::date
        ORDER BY date ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
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
app.get("*", (c) => c.json({ status: "ok", service: "Family Calendar", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3003") }, app.fetch);
