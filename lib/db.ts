import postgres from "npm:postgres@3.4.5";

export type Sql = ReturnType<typeof postgres>;

export interface DbConfig {
  url: string;
}

export function makeSql(cfg: DbConfig): Sql {
  return postgres(cfg.url);
}

export function defaultSql(): Sql {
  const url =
    Deno.env.get("DATABASE_URL") ??
    "postgresql://openbrain:changeme@localhost:5432/openbrain";
  return makeSql({ url });
}
