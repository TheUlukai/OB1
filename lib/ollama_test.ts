import { assertEquals, assertRejects } from "jsr:@std/assert";
import { makeOllamaClient } from "./ollama.ts";

// --- getEmbedding ---

Deno.test("getEmbedding returns first embeddings array", async () => {
  const mockFetch = (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        { status: 200 }
      )
    );

  const client = makeOllamaClient({
    base: "http://fake",
    embedModel: "nomic-embed-text",
    llmModel: "llama3.1:8b",
    fetcher: mockFetch as typeof fetch,
  });

  const result = await client.getEmbedding("hello");
  assertEquals(result, [0.1, 0.2, 0.3]);
});

Deno.test("getEmbedding throws on non-ok response", async () => {
  const mockFetch = () =>
    Promise.resolve(new Response("model not found", { status: 404 }));

  const client = makeOllamaClient({
    base: "http://fake",
    embedModel: "nomic-embed-text",
    llmModel: "llama3.1:8b",
    fetcher: mockFetch as typeof fetch,
  });

  await assertRejects(
    () => client.getEmbedding("hello"),
    Error,
    "Ollama embed failed: 404"
  );
});

// --- extractMetadata ---

Deno.test("extractMetadata parses JSON from message content", async () => {
  const expected = {
    people: [],
    action_items: ["buy milk"],
    dates_mentioned: [],
    topics: ["groceries"],
    type: "task",
  };

  const mockFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ message: { content: JSON.stringify(expected) } }),
        { status: 200 }
      )
    );

  const client = makeOllamaClient({
    base: "http://fake",
    embedModel: "nomic-embed-text",
    llmModel: "llama3.1:8b",
    fetcher: mockFetch as typeof fetch,
  });

  const result = await client.extractMetadata("buy milk");
  assertEquals(result, expected);
});

Deno.test("extractMetadata falls back on malformed JSON", async () => {
  const mockFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ message: { content: "not json" } }),
        { status: 200 }
      )
    );

  const client = makeOllamaClient({
    base: "http://fake",
    embedModel: "nomic-embed-text",
    llmModel: "llama3.1:8b",
    fetcher: mockFetch as typeof fetch,
  });

  const result = await client.extractMetadata("some text");
  assertEquals(result, { topics: ["uncategorized"], type: "observation" });
});
