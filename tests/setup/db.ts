/**
 * Per-suite Postgres testcontainer setup.
 *
 * Usage:
 *   import { withTestDb } from "../setup/db.js";
 *   const ctx = withTestDb();
 *   // Inside tests: ctx.db / ctx.pool / ctx.app / ctx.workspaceId / ctx.userId
 *
 * One container per suite. Migrations + seed applied once in beforeAll.
 */
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import * as schema from "../../src/schema/index.js";

export interface TestDbContext {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  app: Express;
  workspaceId: string;
  userId: string;
}

export function withTestDb(): TestDbContext {
  const ctx = {} as TestDbContext;

  beforeAll(async () => {
    ctx.container = await new PostgreSqlContainer("postgres:17").start();
    process.env.DATABASE_URL = ctx.container.getConnectionUri();

    const { runMigrations } = await import("../../src/db/migrate.js");
    await runMigrations();

    const { seed, SEED_WORKSPACE_ID, SEED_USER_ID } = await import(
      "../../src/db/seed.js"
    );
    const r = await seed();
    if (!r.created) throw new Error("Seed must run clean on empty container");

    ctx.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    ctx.db = drizzle(ctx.pool, { schema });
    ctx.workspaceId = SEED_WORKSPACE_ID;
    ctx.userId = SEED_USER_ID;

    const { buildApp } = await import("../../src/app.js");
    ctx.app = buildApp();
  });

  afterAll(async () => {
    if (ctx.pool) await ctx.pool.end();
    const { pool: seedPool } = await import("../../src/db/client.js");
    await seedPool.end().catch(() => {});
    if (ctx.container) await ctx.container.stop();
  });

  return ctx;
}
