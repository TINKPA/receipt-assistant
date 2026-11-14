-- ═══════════════════════════════════════════════════════════════════════
-- Least-privilege database roles for the two `claude -p` agents.
--
--   receipts_agent   extraction and re-extract. May read, insert into and
--                    update exactly the tables and columns the prompt
--                    templates write. No DELETE, no TRUNCATE, no DDL.
--   receipts_ro      Ask. SELECT only, read-only by default, 30 s timeout.
--
-- Until now both agents connected with the server's own DATABASE_URL, a
-- superuser. A receipt email is text written by a stranger and it is
-- pasted into the extraction prompt, so "the prompt says UPDATE only" was
-- the only thing between a hostile email and DROP TABLE, and superuser
-- also means COPY ... TO PROGRAM in the database container.
--
-- NO SECRETS HERE. The roles are created without a password, so they
-- cannot log in over the network until the server sets one at boot from
-- RECEIPTS_AGENT_DB_PASSWORD / RECEIPTS_RO_DB_PASSWORD
-- (`src/db/agent-roles.ts::syncAgentRoles`).
--
-- The grant list below is `AGENT_GRANTS` in `src/db/agent-roles.ts` as it
-- stood when this file was written. That module is the living source: the
-- server re-applies it at every boot, so a later change to what the agent
-- may touch is an edit there, not a new migration. This file exists so the
-- roles are correct from the moment the migration lands, including when
-- migrations are applied by hand (`npm run db:migrate:prod`).
--
-- Roles belong to the cluster, not the database. Everything here is
-- written to be re-run: on a cluster that already has the roles, and on a
-- database restored from a dump into a cluster that does not.
--
-- NEEDS A CONNECTION THAT MAY CREATE AND ALTER ROLES (a superuser, or a
-- role with CREATEROLE). The compose files connect as `postgres`. With a
-- DATABASE_URL role that merely owns the database this file fails with
-- "permission denied to create role" (or "to alter role"), and because every pending migration
-- runs in one transaction, none of them is applied.
--
-- DDL only. It touches no row.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipts_agent') THEN
    CREATE ROLE receipts_agent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipts_ro') THEN
    CREATE ROLE receipts_ro;
  END IF;
END
$$;--> statement-breakpoint

-- Stated in full so a pre-existing role is brought back to this shape.
-- NOINHERIT: a membership someone adds later grants nothing by itself.
ALTER ROLE receipts_agent WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE receipts_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;--> statement-breakpoint

-- A membership is a second way to hold privileges, and NOINHERIT only
-- means it takes a SET ROLE to use one. Neither role is a member of
-- anything; a pre-existing role is brought back to that.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT g.rolname AS granted, r.rolname AS member, gr.rolname AS grantor
      FROM pg_auth_members am
      JOIN pg_roles g  ON g.oid  = am.roleid
      JOIN pg_roles r  ON r.oid  = am.member
      JOIN pg_roles gr ON gr.oid = am.grantor
     WHERE r.rolname IN ('receipts_agent', 'receipts_ro')
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', m.granted, m.member, m.grantor);
  END LOOP;
END
$$;--> statement-breakpoint

-- Session defaults. A role can override these for its own session, so
-- they are guard rails (a runaway query, a forgotten transaction). The
-- boundary is the privileges further down.
ALTER ROLE receipts_agent SET statement_timeout = '120s';--> statement-breakpoint
ALTER ROLE receipts_agent SET idle_in_transaction_session_timeout = '300s';--> statement-breakpoint
ALTER ROLE receipts_ro SET default_transaction_read_only = 'on';--> statement-breakpoint
ALTER ROLE receipts_ro SET statement_timeout = '30s';--> statement-breakpoint
ALTER ROLE receipts_ro SET idle_in_transaction_session_timeout = '60s';--> statement-breakpoint

-- What every role gets through PUBLIC. Postgres 15+ already withholds
-- CREATE on `public`; a database restored from an older dump may not.
-- TEMPORARY is the one DDL right PUBLIC still has by default. Neither
-- affects the owner connection.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO receipts_agent, receipts_ro', current_database());
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO receipts_agent, receipts_ro;--> statement-breakpoint

-- Creating a large object takes no table privilege, only EXECUTE on these
-- three functions, which PUBLIC holds by default: a role that may write
-- to no table could still write to the database. Nothing in this
-- application uses large objects, and the owner connection is unaffected.
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid), pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;--> statement-breakpoint

-- Start from nothing, so a re-run converges on the list below instead of
-- adding to whatever was there.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM receipts_agent, receipts_ro;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM receipts_agent, receipts_ro;--> statement-breakpoint

-- ── receipts_ro ────────────────────────────────────────────────────────
-- Reads everything in `public`, now and later: the default privilege
-- covers tables this role (the one running migrations) creates from here
-- on, so a new table is never silently unreadable to Ask. It is never
-- writable: nothing but SELECT is ever granted.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO receipts_ro;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO receipts_ro;--> statement-breakpoint

-- ── receipts_agent ─────────────────────────────────────────────────────
-- No default privilege: a table added later is invisible to the
-- extraction agent until it is listed in AGENT_GRANTS.
--
-- Every table below is readable. The second column says whether the role
-- may INSERT; the third lists the columns it may UPDATE. UPDATE is per
-- column so that being able to stamp `transactions.metadata` does not
-- also mean being able to set `deleted_at` on every row. There is no
-- DELETE anywhere.
--
-- A loop rather than forty GRANT lines, for one reason: this file can be
-- applied after other migrations have changed the schema, and a GRANT that
-- names a missing column would abort the transaction every pending
-- migration runs in, which is a server that will not boot. A name that no
-- longer exists is skipped with a WARNING here, and the boot-time sync
-- reports it again from the current AGENT_GRANTS.
DO $$
DECLARE
  g       record;
  rel     regclass;
  cols    text;
  n_found int;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('accounts',            true,  ARRAY['updated_at']),
      ('brand_assets',        true,  ARRAY['last_seen_at', 'agent_relevance', 'agent_notes',
                                           'extraction_version', 'retired_at', 'width', 'height',
                                           'content_type']),
      ('brands',              true,  ARRAY['name', 'domain', 'parent_id', 'preferred_asset_id',
                                           'metadata', 'updated_at']),
      ('document_links',      true,  ARRAY[]::text[]),
      ('documents',           false, ARRAY['source_ingest_id', 'ocr_text', 'ocr_model_version',
                                           'message_id', 'source_meta', 'updated_at']),
      ('ingests',             false, ARRAY['status', 'classification', 'produced', 'error',
                                           'completed_at']),
      ('merchants',           true,  ARRAY['updated_at']),
      ('owned_items',         true,  ARRAY['retired_at', 'condition', 'notes', 'updated_at']),
      ('place_photos',        true,  ARRAY[]::text[]),
      ('place_snapshots',     true,  ARRAY[]::text[]),
      ('places',              true,  ARRAY['last_seen_at', 'hit_count', 'raw_response',
                                           'display_name_en', 'display_name_zh',
                                           'display_name_zh_locale', 'display_name_zh_source',
                                           'display_name_zh_is_native', 'primary_type',
                                           'primary_type_display_zh', 'maps_type_label_zh', 'types',
                                           'formatted_address_en', 'formatted_address_zh',
                                           'postal_code', 'country_code', 'business_status',
                                           'business_hours', 'time_zone', 'rating',
                                           'user_rating_count', 'national_phone_number',
                                           'website_uri', 'google_maps_uri', 'lat', 'lng']),
      ('postings',            true,  ARRAY[]::text[]),
      ('products',            true,  ARRAY['canonical_name', 'brand_id', 'item_class',
                                           'first_purchased_on', 'last_purchased_on',
                                           'purchase_count', 'total_spent_minor', 'updated_at']),
      ('transaction_events',  true,  ARRAY[]::text[]),
      ('transaction_items',   true,  ARRAY['retired_at']),
      ('transaction_parties', true,  ARRAY[]::text[]),
      ('transactions',        true,  ARRAY['occurred_on', 'occurred_at', 'payee', 'metadata',
                                           'place_id', 'version', 'updated_at'])
    ) AS t(tbl, can_insert, upd)
  LOOP
    rel := to_regclass(format('public.%I', g.tbl));
    IF rel IS NULL THEN
      RAISE WARNING '0041: table % does not exist; receipts_agent gets nothing on it', g.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT%s ON %s TO receipts_agent',
                   CASE WHEN g.can_insert THEN ', INSERT' ELSE '' END, rel);
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum), count(*)
      INTO cols, n_found
      FROM pg_attribute a
     WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = ANY (g.upd);
    IF cols IS NOT NULL THEN
      EXECUTE format('GRANT UPDATE (%s) ON %s TO receipts_agent', cols, rel);
    END IF;
    IF n_found <> COALESCE(array_length(g.upd, 1), 0) THEN
      RAISE WARNING '0041: % of the UPDATE columns listed for % do not exist and were skipped',
        COALESCE(array_length(g.upd, 1), 0) - n_found, g.tbl;
    END IF;
  END LOOP;
END
$$;
