/**
 * Drizzle migration runner.
 *
 * Imported by:
 *   - `src/server.ts` at container boot (production path).
 *   - `scripts/migrate.ts` as a standalone CLI (dev path, via tsx).
 *
 * Also runnable as a standalone script — `node dist/db/migrate.js` — via the
 * main-guard at the bottom. This is the prod-safe, tsx-free migrate path
 * (`npm run db:migrate:prod`): tsx is a dev dependency and is absent from the
 * production runtime image, so `npm run db:migrate` (which uses tsx) fails
 * there. The compiled file works both as an import (no side effects) and as a
 * direct entry point.
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
import { fileURLToPath, pathToFileURL } from "url";

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

// Main-guard: when this file is executed directly (`node dist/db/migrate.js`,
// i.e. `npm run db:migrate:prod`) apply migrations and exit. Fires only on
// direct execution, never on import (server boot / scripts/migrate.ts), so the
// same compiled artifact serves both roles. This is the tsx-free prod path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(() => {
      console.log("✅ Migrations complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Migration failed:", err);
      process.exit(1);
    });
}
