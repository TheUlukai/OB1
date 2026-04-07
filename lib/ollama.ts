type Fetcher = typeof fetch;

export interface OllamaConfig {
  base: string;
  embedModel: string;
  llmModel: string;
  fetcher?: Fetcher;
}

export interface OllamaClient {
  getEmbedding(text: string): Promise<number[]>;
  extractMetadata(text: string): Promise<Record<string, unknown>>;
}

export function makeOllamaClient(cfg: OllamaConfig): OllamaClient {
  const fetcher: Fetcher = cfg.fetcher ?? globalThis.fetch;

  return {
    async getEmbedding(text: string): Promise<number[]> {
      const r = await fetcher(`${cfg.base}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.embedModel, input: text }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`Ollama embed failed: ${r.status} ${msg}`);
      }
      const d = await r.json();
      return d.embeddings[0];
    },

    async extractMetadata(text: string): Promise<Record<string, unknown>> {
      const r = await fetcher(`${cfg.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.llmModel,
          stream: false,
          format: "json",
          messages: [
            {
              role: "system",
              content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
            },
            { role: "user", content: text },
          ],
        }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`Ollama chat failed: ${r.status} ${msg}`);
      }
      const d = await r.json();
      try {
        return JSON.parse(d.message.content);
      } catch {
        return { topics: ["uncategorized"], type: "observation" };
      }
    },
  };
}

export function defaultOllamaClient(): OllamaClient {
  return makeOllamaClient({
    base: Deno.env.get("OLLAMA_BASE") ?? "http://localhost:11434",
    embedModel: Deno.env.get("OLLAMA_EMBED_MODEL") ?? "nomic-embed-text",
    llmModel: Deno.env.get("OLLAMA_LLM_MODEL") ?? "llama3.1:8b",
  });
}
