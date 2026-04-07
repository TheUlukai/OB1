/**
 * server/handlers.ts
 *
 * Business logic for the 4 core Open Brain tools.
 * Extracted from index.ts so it can be tested without an HTTP server.
 *
 * All functions accept a `sql` connection and an `ollama` client so callers
 * (index.ts or tests) can inject real or fake implementations.
 */

import pgvector from "pgvector";
import type { Sql } from "../lib/db.ts";
import type { OllamaClient } from "../lib/ollama.ts";

const DEFAULT_USER_ID = Deno.env.get("DEFAULT_USER_ID") ?? "default";

// ---------------------------------------------------------------------------
// capture_thought
// ---------------------------------------------------------------------------

export async function captureThought(
  content: string,
  sql: Sql,
  ollama: OllamaClient,
  userId = DEFAULT_USER_ID
) {
  const [embedding, metadata] = await Promise.all([
    ollama.getEmbedding(content),
    ollama.extractMetadata(content),
  ]);

  const [row] = await sql`
    INSERT INTO thoughts (user_id, content, embedding, metadata)
    VALUES (
      ${userId},
      ${content},
      ${pgvector.toSql(embedding)},
      ${JSON.stringify({ ...metadata, source: "mcp" })}
    )
    RETURNING id, metadata
  `;

  return { id: row.id, metadata: row.metadata };
}

// ---------------------------------------------------------------------------
// search_thoughts
// ---------------------------------------------------------------------------

export async function searchThoughts(
  query: string,
  limit: number,
  threshold: number,
  sql: Sql,
  ollama: OllamaClient,
  userId = DEFAULT_USER_ID
) {
  const qEmb = await ollama.getEmbedding(query);

  const rows = await sql`
    SELECT content, metadata, created_at,
           1 - (embedding <=> ${pgvector.toSql(qEmb)}::vector) AS similarity
    FROM thoughts
    WHERE user_id = ${userId}
      AND 1 - (embedding <=> ${pgvector.toSql(qEmb)}::vector) >= ${threshold}
    ORDER BY embedding <=> ${pgvector.toSql(qEmb)}::vector
    LIMIT ${limit}
  `;

  return rows as unknown as Array<{
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    similarity: number;
  }>;
}

// ---------------------------------------------------------------------------
// list_thoughts
// ---------------------------------------------------------------------------

export async function listThoughts(
  opts: {
    limit: number;
    type?: string;
    topic?: string;
    person?: string;
    days?: number;
  },
  sql: Sql,
  userId = DEFAULT_USER_ID
) {
  const { limit, type, topic, person, days } = opts;

  const rows = await sql`
    SELECT content, metadata, created_at
    FROM thoughts
    WHERE user_id = ${userId}
      AND (${type ?? null} IS NULL OR metadata->>'type' = ${type ?? null})
      AND (${topic ?? null} IS NULL OR metadata->'topics' ? ${topic ?? null})
      AND (${person ?? null} IS NULL OR metadata->'people' ? ${person ?? null})
      AND (${days ?? null} IS NULL
           OR created_at >= NOW() - (${days ?? 0} || ' days')::interval)
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return rows as unknown as Array<{
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
}

// ---------------------------------------------------------------------------
// thought_stats
// ---------------------------------------------------------------------------

export async function thoughtStats(sql: Sql, userId = DEFAULT_USER_ID) {
  const [counts] = await sql`
    SELECT
      COUNT(*)::int                                    AS total,
      jsonb_object_agg(type, cnt) FILTER (WHERE type IS NOT NULL) AS types
    FROM (
      SELECT metadata->>'type' AS type, COUNT(*)::int AS cnt
      FROM thoughts
      WHERE user_id = ${userId}
      GROUP BY metadata->>'type'
    ) t
  `;

  const topicRows = await sql`
    SELECT topic, COUNT(*)::int AS cnt
    FROM thoughts, jsonb_array_elements_text(
      CASE jsonb_typeof(metadata->'topics')
        WHEN 'array' THEN metadata->'topics'
        ELSE '[]'::jsonb
      END
    ) AS topic
    WHERE user_id = ${userId}
    GROUP BY topic
    ORDER BY cnt DESC
    LIMIT 10
  `;

  const peopleRows = await sql`
    SELECT person, COUNT(*)::int AS cnt
    FROM thoughts, jsonb_array_elements_text(
      CASE jsonb_typeof(metadata->'people')
        WHEN 'array' THEN metadata->'people'
        ELSE '[]'::jsonb
      END
    ) AS person
    WHERE user_id = ${userId}
    GROUP BY person
    ORDER BY cnt DESC
    LIMIT 10
  `;

  const [dateRange] = await sql`
    SELECT
      MIN(created_at)::text AS oldest,
      MAX(created_at)::text AS newest
    FROM thoughts
    WHERE user_id = ${userId}
  `;

  return {
    total: counts.total as number,
    types: (counts.types ?? {}) as Record<string, number>,
    topTopics: topicRows as unknown as Array<{ topic: string; cnt: number }>,
    topPeople: peopleRows as unknown as Array<{ person: string; cnt: number }>,
    dateRange: {
      oldest: dateRange.oldest as string | null,
      newest: dateRange.newest as string | null,
    },
  };
}
