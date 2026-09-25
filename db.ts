import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string) {
  return new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 10
  });
}

export async function migrate(pool: pg.Pool) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../migrations/001_init.sql"),
    path.resolve(here, "../../migrations/001_init.sql")
  ];
  let sql: string | undefined;
  for (const candidate of candidates) {
    try {
      sql = await fs.readFile(candidate, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!sql) throw new Error("No se encontró migrations/001_init.sql");
  await pool.query(sql);
}
