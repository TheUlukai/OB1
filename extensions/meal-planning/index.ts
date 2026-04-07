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

const server = new McpServer({ name: "meal-planning", version: "1.0.0" });

server.registerTool(
  "add_recipe",
  {
    title: "Add Recipe",
    description: "Add a recipe",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      ingredients: z.array(z.object({ name: z.string(), quantity: z.string(), unit: z.string() })).optional(),
      instructions: z.string().optional().describe("Step-by-step instructions as text"),
      prep_time_minutes: z.number().optional(),
      cook_time_minutes: z.number().optional(),
      servings: z.number().optional(),
      tags: z.array(z.string()).optional(),
      rating: z.number().min(1).max(5).optional(),
      notes: z.string().optional(),
    },
  },
  async ({ title, description, ingredients, instructions, prep_time_minutes, cook_time_minutes, servings, tags, rating, notes }) => {
    try {
      const [row] = await sql`
        INSERT INTO recipes (user_id, title, description, ingredients, instructions,
                             prep_time_minutes, cook_time_minutes, servings, tags, rating, notes)
        VALUES (${DEFAULT_USER_ID}, ${title}, ${description ?? null},
                ${JSON.stringify(ingredients ?? [])}::jsonb,
                ${instructions ?? null}, ${prep_time_minutes ?? null},
                ${cook_time_minutes ?? null}, ${servings ?? null},
                ${tags ? sql.array(tags) : sql`'{}'::text[]`},
                ${rating ?? null}, ${notes ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "search_recipes",
  {
    title: "Search Recipes",
    description: "Search recipes by title or tag",
    inputSchema: {
      query: z.string().optional(),
      tag: z.string().optional(),
    },
  },
  async ({ query, tag }) => {
    try {
      const rows = await sql`
        SELECT * FROM recipes
        WHERE user_id = ${DEFAULT_USER_ID}
          AND (${query ?? null} IS NULL OR (
                title ILIKE ${"%" + (query ?? "") + "%"} OR
                description ILIKE ${"%" + (query ?? "") + "%"}
              ))
          AND (${tag ?? null} IS NULL OR ${tag ?? null} = ANY(tags))
        ORDER BY created_at DESC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "update_recipe",
  {
    title: "Update Recipe",
    description: "Update an existing recipe",
    inputSchema: {
      recipe_id: z.string().describe("Recipe ID (UUID)"),
      title: z.string().optional(),
      description: z.string().optional(),
      ingredients: z.array(z.object({ name: z.string(), quantity: z.string(), unit: z.string() })).optional(),
      instructions: z.string().optional(),
      prep_time_minutes: z.number().optional(),
      cook_time_minutes: z.number().optional(),
      servings: z.number().optional(),
      tags: z.array(z.string()).optional(),
      rating: z.number().min(1).max(5).optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const { recipe_id, ...fields } = args;
      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;
      if (fields.title !== undefined)             { sets.push(`title = $${idx++}`);              vals.push(fields.title); }
      if (fields.description !== undefined)       { sets.push(`description = $${idx++}`);        vals.push(fields.description); }
      if (fields.ingredients !== undefined)       { sets.push(`ingredients = $${idx++}::jsonb`); vals.push(JSON.stringify(fields.ingredients)); }
      if (fields.instructions !== undefined)      { sets.push(`instructions = $${idx++}`);       vals.push(fields.instructions); }
      if (fields.prep_time_minutes !== undefined) { sets.push(`prep_time_minutes = $${idx++}`);  vals.push(fields.prep_time_minutes); }
      if (fields.cook_time_minutes !== undefined) { sets.push(`cook_time_minutes = $${idx++}`);  vals.push(fields.cook_time_minutes); }
      if (fields.servings !== undefined)          { sets.push(`servings = $${idx++}`);           vals.push(fields.servings); }
      if (fields.tags !== undefined)              { sets.push(`tags = $${idx++}`);               vals.push(fields.tags); }
      if (fields.rating !== undefined)            { sets.push(`rating = $${idx++}`);             vals.push(fields.rating); }
      if (fields.notes !== undefined)             { sets.push(`notes = $${idx++}`);              vals.push(fields.notes); }
      if (!sets.length) throw new Error("No fields to update");
      vals.push(recipe_id, DEFAULT_USER_ID);
      const rows = await sql.unsafe(
        `UPDATE recipes SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
        vals as never[]
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(rows[0], null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "plan_week",
  {
    title: "Plan Week",
    description: "Set or update the meal plan for a week. The plan is a free-form JSON object (e.g. {\"monday\": {\"dinner\": \"pasta\"}})",
    inputSchema: {
      week_start: z.string().describe("Monday of the week (YYYY-MM-DD)"),
      plan: z.record(z.string(), z.unknown()).describe("Meal plan keyed by day/meal"),
      notes: z.string().optional(),
    },
  },
  async ({ week_start, plan, notes }) => {
    try {
      const existing = await sql`
        SELECT id FROM meal_plans WHERE user_id = ${DEFAULT_USER_ID} AND week_start = ${week_start}::date
      `;
      let row;
      if (existing.length) {
        [row] = await sql`
          UPDATE meal_plans SET plan = ${JSON.stringify(plan)}::jsonb, notes = ${notes ?? null}
          WHERE id = ${existing[0].id} RETURNING *
        `;
      } else {
        [row] = await sql`
          INSERT INTO meal_plans (user_id, week_start, plan, notes)
          VALUES (${DEFAULT_USER_ID}, ${week_start}::date, ${JSON.stringify(plan)}::jsonb, ${notes ?? null})
          RETURNING *
        `;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_meal_plan",
  {
    title: "Get Meal Plan",
    description: "View the meal plan and shopping list for a given week",
    inputSchema: { week_start: z.string().describe("YYYY-MM-DD") },
  },
  async ({ week_start }) => {
    try {
      const rows = await sql`
        SELECT mp.*,
               COALESCE(json_agg(sli.*) FILTER (WHERE sli.id IS NOT NULL), '[]') AS shopping_items
        FROM meal_plans mp
        LEFT JOIN shopping_list_items sli ON sli.meal_plan_id = mp.id
        WHERE mp.user_id = ${DEFAULT_USER_ID} AND mp.week_start = ${week_start}::date
        GROUP BY mp.id
      `;
      if (!rows.length) return { content: [{ type: "text" as const, text: "No meal plan found for this week." }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(rows[0], null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "add_shopping_item",
  {
    title: "Add Shopping Item",
    description: "Add an item to the shopping list for a week",
    inputSchema: {
      week_start: z.string().describe("YYYY-MM-DD"),
      item: z.string(),
      quantity: z.string().optional().describe("e.g. '2 cups', '1 kg'"),
    },
  },
  async ({ week_start, item, quantity }) => {
    try {
      const plans = await sql`
        SELECT id FROM meal_plans WHERE user_id = ${DEFAULT_USER_ID} AND week_start = ${week_start}::date
      `;
      let planId: string;
      if (plans.length) {
        planId = plans[0].id as string;
      } else {
        const [newPlan] = await sql`
          INSERT INTO meal_plans (user_id, week_start, plan) VALUES (${DEFAULT_USER_ID}, ${week_start}::date, '{}'::jsonb) RETURNING id
        `;
        planId = newPlan.id as string;
      }
      const [row] = await sql`
        INSERT INTO shopping_list_items (meal_plan_id, user_id, item, quantity)
        VALUES (${planId}, ${DEFAULT_USER_ID}, ${item}, ${quantity ?? null})
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, item: row }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_shopping_list",
  {
    title: "Get Shopping List",
    description: "Get the shopping list for a week",
    inputSchema: {
      week_start: z.string().describe("YYYY-MM-DD"),
      include_purchased: z.boolean().optional().describe("Include purchased items (default false)"),
    },
  },
  async ({ week_start, include_purchased = false }) => {
    try {
      const rows = await sql`
        SELECT sli.* FROM shopping_list_items sli
        JOIN meal_plans mp ON sli.meal_plan_id = mp.id
        WHERE mp.user_id = ${DEFAULT_USER_ID}
          AND mp.week_start = ${week_start}::date
          AND (${include_purchased} OR sli.purchased = false)
        ORDER BY sli.purchased ASC, sli.item ASC
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, items: rows }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  }
);

server.registerTool(
  "mark_purchased",
  {
    title: "Mark Purchased",
    description: "Mark a shopping list item as purchased",
    inputSchema: { item_id: z.string().describe("Shopping list item ID (UUID)") },
  },
  async ({ item_id }) => {
    try {
      const [row] = await sql`
        UPDATE shopping_list_items SET purchased = true
        WHERE id = ${item_id} AND user_id = ${DEFAULT_USER_ID}
        RETURNING *
      `;
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, item: row }, null, 2) }] };
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
app.get("*", (c) => c.json({ status: "ok", service: "Meal Planning", version: "1.0.0" }));
Deno.serve({ port: parseInt(Deno.env.get("PORT") ?? "3004") }, app.fetch);
