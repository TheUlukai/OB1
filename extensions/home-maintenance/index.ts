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

const server = new McpServer({ name: "home-maintenance", version: "1.0.0" });

server.registerTool(
  "add_maintenance_task",
  {
    title: "Add Maintenance Task",
    description: "Create a new maintenance task (recurring or one-time)",
    inputSchema: {
      title: z.string().describe("Name of the task"),
      description: z.string().optional().describe("Description or category"),
      location: z.string().optional().describe("Location in the home"),
      frequency_days: z.number().optional().describe("Recurrence in days (e.g. 90, 365). Omit for one-time."),
      next_due: z.string().optional().describe("Next due date (YYYY-MM-DD)"),
    },
  },
  async ({ title, description, location, frequency_days, next_due }) => {
    try {
      const [row] = await sql`
        INSERT INTO maintenance_tasks (user_id, title, description, location, frequency_days, next_due)
        VALUES (${DEFAULT_USER_ID}, ${title}, ${description ?? null}, ${location ?? null},
                ${frequency_days ?? null}, ${next_due ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, task: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "log_maintenance",
  {
    title: "Log Maintenance",
    description: "Log that a maintenance task was completed. Updates last_completed and advances next_due.",
    inputSchema: {
      task_id: z.string().describe("Task ID (UUID)"),
      completed_at: z.string().optional().describe("Date completed (YYYY-MM-DD). Defaults to today."),
      notes: z.string().optional(),
      cost: z.number().optional(),
    },
  },
  async ({ task_id, completed_at, notes, cost }) => {
    try {
      const doneDate = completed_at ?? new Date().toISOString().split("T")[0];
      const [log] = await sql`
        INSERT INTO maintenance_logs (user_id, task_id, completed_at, notes, cost)
        VALUES (${DEFAULT_USER_ID}, ${task_id}, ${doneDate}, ${notes ?? null}, ${cost ?? null})
        RETURNING *
      `;
      const [task] = await sql`
        UPDATE maintenance_tasks
        SET last_completed = ${doneDate},
            next_due = CASE
              WHEN frequency_days IS NOT NULL
                THEN (${doneDate}::date + frequency_days * INTERVAL '1 day')::date
              ELSE next_due
            END
        WHERE id = ${task_id} AND user_id = ${DEFAULT_USER_ID}
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, log, updated_task: task }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_upcoming_maintenance",
  {
    title: "Get Upcoming Maintenance",
    description: "List maintenance tasks due in the next N days",
    inputSchema: { days_ahead: z.number().optional().describe("Days to look ahead (default 30)") },
  },
  async ({ days_ahead = 30 }) => {
    try {
      const rows = await sql`
        SELECT * FROM maintenance_tasks
        WHERE user_id = ${DEFAULT_USER_ID}
          AND next_due IS NOT NULL
          AND next_due <= (CURRENT_DATE + ${days_ahead} * INTERVAL '1 day')::date
        ORDER BY next_due ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, days_ahead, count: rows.length, tasks: rows }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "search_maintenance_history",
  {
    title: "Search Maintenance History",
    description: "Search maintenance logs by task title or date range",
    inputSchema: {
      task_title: z.string().optional().describe("Filter by task title (partial match)"),
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
  },
  async ({ task_title, date_from, date_to }) => {
    try {
      const rows = await sql`
        SELECT ml.*, mt.title AS task_title, mt.description AS task_description
        FROM maintenance_logs ml
        JOIN maintenance_tasks mt ON ml.task_id = mt.id
        WHERE ml.user_id = ${DEFAULT_USER_ID}
          AND (${task_title ?? null} IS NULL OR mt.title ILIKE ${"%" + (task_title ?? "") + "%"})
          AND (${date_from ?? null} IS NULL OR ml.completed_at >= ${date_from ?? null}::date)
          AND (${date_to ?? null} IS NULL OR ml.completed_at <= ${date_to ?? null}::date)
        ORDER BY ml.completed_at DESC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: rows.length, logs: rows }, null, 2) }] };
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
app.get("*", (c) => c.json({ status: "ok", service: "Home Maintenance Tracker", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3002") }, app.fetch);
