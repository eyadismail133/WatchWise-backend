-- scripts/prepare-legacy-watchlist.sql
-- Narrow, atomic, strict guarded preparation script for migrating legacy WatchWise databases.
-- Creates TmdbMediaType enum and nullable mapping columns on watchlist_items.

DO $prep$
DECLARE
    v_actual_labels text[];
    v_col RECORD;
BEGIN
    SET LOCAL search_path = public;

    -- Guard: target table must exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'watchlist_items'
    ) THEN
        RAISE EXCEPTION 'Target table "watchlist_items" does not exist in schema "public".';
    END IF;

    -- Enum TmdbMediaType: validate if exists, or create
    IF EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'TmdbMediaType'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typname = 'TmdbMediaType' AND t.typtype = 'e'
        ) THEN
            RAISE EXCEPTION 'Type "public"."TmdbMediaType" exists but is not an enum.';
        END IF;

        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
        INTO v_actual_labels
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'TmdbMediaType';

        IF v_actual_labels IS DISTINCT FROM ARRAY['movie', 'tv']::text[] THEN
            RAISE EXCEPTION 'Incompatible enum labels on "public"."TmdbMediaType": expected [movie, tv], found %', v_actual_labels;
        END IF;
    ELSE
        CREATE TYPE "TmdbMediaType" AS ENUM ('movie', 'tv');
    END IF;

    -- Column tmdbId: validate if exists, or create
    SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'watchlist_items' AND column_name = 'tmdbId';
    IF FOUND THEN
        IF v_col.data_type <> 'integer' OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
            RAISE EXCEPTION 'Incompatible existing column watchlist_items.tmdbId: expected nullable integer with no default.';
        END IF;
    ELSE
        ALTER TABLE "watchlist_items" ADD COLUMN "tmdbId" INTEGER;
    END IF;

    -- Column mediaType: validate if exists, or create
    SELECT data_type, udt_name, is_nullable, column_default INTO v_col
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'watchlist_items' AND column_name = 'mediaType';
    IF FOUND THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_type t ON t.oid = a.atttypid
            JOIN pg_namespace tn ON tn.oid = t.typnamespace
            WHERE n.nspname = 'public' AND c.relname = 'watchlist_items' AND a.attname = 'mediaType'
              AND tn.nspname = 'public' AND t.typname = 'TmdbMediaType' AND t.typtype = 'e'
        ) OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
            RAISE EXCEPTION 'Incompatible existing column watchlist_items.mediaType: expected nullable public.TmdbMediaType with no default.';
        END IF;
    ELSE
        ALTER TABLE "watchlist_items" ADD COLUMN "mediaType" "TmdbMediaType";
    END IF;
END $prep$;

-- OPERATOR INSTRUCTIONS:
-- Populate verified authoritative mappings for each legacy watchlist item by row id.
-- Internal titleId MUST NEVER be used as tmdbId.
-- Examples:
-- UPDATE "watchlist_items" SET "tmdbId" = 27205, "mediaType" = 'movie'::"TmdbMediaType" WHERE "id" = 101;
-- UPDATE "watchlist_items" SET "tmdbId" = 1396, "mediaType" = 'tv'::"TmdbMediaType" WHERE "id" = 102;
