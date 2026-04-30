/**
 * Drizzle migration runner.
 *
 * Imported by:
 *   - `src/server.ts` at container boot (production path).
 *   - `scripts/migrate.ts` as a standalone CLI (dev path, via tsx).
 *
 * `migrationsFolder` resolves relative to the compiled file location.
 * In dev   : <repo>/src/db/migrate.ts → <repo>/drizzle
 * In prod  : <repo>/dist/db/migrate.js → <repo>/drizzle
 * Both layouts put `drizzle/` two levels up from this file.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.resolve(__dirname, "..", "..", "drizzle");

export async function runMigrations(databaseUrl?: string): Promise<void> {
  const url =
    databaseUrl ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/receipts";

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
