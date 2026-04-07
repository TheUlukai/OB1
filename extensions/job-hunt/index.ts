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

const server = new McpServer({ name: "job-hunt", version: "1.0.0" });

server.registerTool(
  "add_company",
  {
    title: "Add Company",
    description: "Add a company to track in your job search",
    inputSchema: {
      name: z.string(),
      industry: z.string().optional(),
      website: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  async ({ name, industry, website, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO job_companies (user_id, name, industry, website, notes)
        VALUES (${DEFAULT_USER_ID}, ${name}, ${industry ?? null}, ${website ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, company: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "add_job_posting",
  {
    title: "Add Job Posting",
    description: "Add a job posting at a company",
    inputSchema: {
      company_id: z.string().describe("Company ID (UUID)"),
      title: z.string(),
      url: z.string().optional(),
      description: z.string().optional(),
      salary_range: z.string().optional().describe("e.g. '$120k-$150k'"),
      notes: z.string().optional(),
    },
  },
  async ({ company_id, title, url, description, salary_range, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO job_postings (user_id, company_id, title, url, description, salary_range, notes)
        VALUES (${DEFAULT_USER_ID}, ${company_id}, ${title}, ${url ?? null},
                ${description ?? null}, ${salary_range ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, posting: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "apply_to_job",
  {
    title: "Apply to Job",
    description: "Record that you applied to a job posting",
    inputSchema: {
      posting_id: z.string().describe("Job posting ID (UUID)"),
      applied_at: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
      status: z.enum(["applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional(),
      notes: z.string().optional(),
    },
  },
  async ({ posting_id, applied_at, status, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO job_applications (user_id, posting_id, applied_at, status, notes)
        VALUES (${DEFAULT_USER_ID}, ${posting_id},
                ${applied_at ?? new Date().toISOString().split("T")[0]},
                ${status ?? "applied"}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, application: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "schedule_interview",
  {
    title: "Schedule Interview",
    description: "Schedule an interview for a job application",
    inputSchema: {
      application_id: z.string().describe("Application ID (UUID)"),
      interview_type: z.enum(["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"]),
      scheduled_at: z.string().optional().describe("ISO 8601 datetime"),
      interviewer_name: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  async ({ application_id, interview_type, scheduled_at, interviewer_name, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, interviewer_name, notes)
        VALUES (${DEFAULT_USER_ID}, ${application_id}, ${interview_type},
                ${scheduled_at ?? null}, ${interviewer_name ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, interview: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "log_interview_outcome",
  {
    title: "Log Interview Outcome",
    description: "Record the outcome and notes after an interview",
    inputSchema: {
      interview_id: z.string().describe("Interview ID (UUID)"),
      outcome: z.string().optional().describe("e.g. 'passed', 'rejected', 'pending'"),
      notes: z.string().optional(),
    },
  },
  async ({ interview_id, outcome, notes }) => {
    try {
      const [row] = await sql`
        UPDATE interviews
        SET outcome = ${outcome ?? null}, notes = COALESCE(${notes ?? null}, notes)
        WHERE id = ${interview_id} AND user_id = ${DEFAULT_USER_ID}
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, interview: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_pipeline_overview",
  {
    title: "Get Pipeline Overview",
    description: "Summary of your job search: application counts by status and upcoming interviews",
    inputSchema: { days_ahead: z.number().optional().describe("Days ahead for interviews (default 7)") },
  },
  async ({ days_ahead = 7 }) => {
    try {
      const apps = await sql`
        SELECT status, COUNT(*)::int AS cnt FROM job_applications
        WHERE user_id = ${DEFAULT_USER_ID} GROUP BY status
      `;
      const statusBreakdown = Object.fromEntries(apps.map((r) => [r.status, r.cnt]));
      const futureDate = new Date(Date.now() + days_ahead * 86400000).toISOString();
      const upcoming = await sql`
        SELECT i.*, jp.title AS job_title, jc.name AS company_name
        FROM interviews i
        JOIN job_applications ja ON i.application_id = ja.id
        JOIN job_postings jp ON ja.posting_id = jp.id
        JOIN job_companies jc ON jp.company_id = jc.id
        WHERE i.user_id = ${DEFAULT_USER_ID}
          AND i.scheduled_at >= NOW() AND i.scheduled_at <= ${futureDate}
          AND i.outcome IS NULL
        ORDER BY i.scheduled_at ASC
      `;
      const [totals] = await sql`SELECT COUNT(*)::int AS total FROM job_applications WHERE user_id = ${DEFAULT_USER_ID}`;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, total_applications: totals.total, status_breakdown: statusBreakdown, upcoming_interviews: upcoming }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_upcoming_interviews",
  {
    title: "Get Upcoming Interviews",
    description: "List interviews in the next N days",
    inputSchema: { days_ahead: z.number().optional().describe("Default 14") },
  },
  async ({ days_ahead = 14 }) => {
    try {
      const futureDate = new Date(Date.now() + days_ahead * 86400000).toISOString();
      const rows = await sql`
        SELECT i.*, jp.title AS job_title, jc.name AS company_name
        FROM interviews i
        JOIN job_applications ja ON i.application_id = ja.id
        JOIN job_postings jp ON ja.posting_id = jp.id
        JOIN job_companies jc ON jp.company_id = jc.id
        WHERE i.user_id = ${DEFAULT_USER_ID}
          AND i.scheduled_at >= NOW() AND i.scheduled_at <= ${futureDate}
        ORDER BY i.scheduled_at ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: rows.length, interviews: rows }, null, 2) }] };
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
app.get("*", (c) => c.json({ status: "ok", service: "Job Hunt Pipeline", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3006") }, app.fetch);
