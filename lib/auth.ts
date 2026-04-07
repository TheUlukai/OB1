import type { Context, Next } from "hono";

export async function authMiddleware(c: Context, next: Next) {
  const key = c.req.header("x-brain-key") ?? c.req.query("key");
  const expected = Deno.env.get("MCP_ACCESS_KEY");
  if (!key || key !== expected) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }
  return next();
}
