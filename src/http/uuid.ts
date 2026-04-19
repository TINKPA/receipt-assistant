/**
 * Thin wrapper around the `uuid` package — centralizes our dependency
 * on UUIDv7 so we can swap to PostgreSQL-native `uuidv7()` once PG 18
 * is baseline.
 *
 * Never use v4 for app-generated IDs: v7 is time-ordered, which is a
 * 10x B-tree index locality improvement for our keyset-paginated
 * tables.
 */
import { v7 } from "uuid";

export const newId = (): string => v7();
