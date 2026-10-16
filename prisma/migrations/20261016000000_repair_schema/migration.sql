-- Corrective migration: reconcile historical schema with modern Prisma schema
-- Single atomic PostgreSQL operation via DO $migration$ PL/pgSQL block.
DO $migration$
DECLARE
    v_count INTEGER;
    v_actual_labels text[];
    v_col RECORD;
    v_prep_tmdbId_exists boolean;
    v_prep_mediaType_exists boolean;
BEGIN
    -- Constrain search_path to public
    SET LOCAL search_path = public;

    -- ========================================================================
    -- 1. Guard user required fields & uniqueness
    -- ========================================================================
    -- Check for NULL name on users
    SELECT count(*) INTO v_count FROM "users" WHERE "name" IS NULL;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Cannot migrate users: % row(s) have NULL name. Required field "name" must be populated with non-null values before migrating.', v_count;
    END IF;

    -- Check for NULL email on users
    SELECT count(*) INTO v_count FROM "users" WHERE "email" IS NULL;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Cannot migrate users: % row(s) have NULL email. Required field "email" must be populated with non-null values before migrating.', v_count;
    END IF;

    -- Check for duplicate emails on users
    SELECT count(*) INTO v_count FROM (
        SELECT "email" FROM "users" GROUP BY "email" HAVING count(*) > 1
    ) d;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Cannot migrate users: duplicate emails detected in users table.';
    END IF;

    -- Check for duplicate account records on (providerId, accountId)
    SELECT count(*) INTO v_count FROM (
        SELECT "providerId", "accountId" FROM "account" GROUP BY "providerId", "accountId" HAVING count(*) > 1
    ) d;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Cannot apply unique constraint on account(providerId, accountId): duplicate records exist.';
    END IF;

    -- ========================================================================
    -- 2. Validate Enum & Preparation Objects
    -- ========================================================================
    -- Check if TmdbMediaType already exists (allowed only via prepare step)
    IF EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'TmdbMediaType'
    ) THEN
        -- Verify it is an enum
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typname = 'TmdbMediaType' AND t.typtype = 'e'
        ) THEN
            RAISE EXCEPTION 'Type "public"."TmdbMediaType" exists but is not an enum.';
        END IF;

        -- Verify exact labels and order
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
        -- Fresh chain: create enum
        CREATE TYPE "TmdbMediaType" AS ENUM ('movie', 'tv');
    END IF;

    -- Create ActivityType enum (must not pre-exist in legacy DB)
    CREATE TYPE "ActivityType" AS ENUM (
        'added_to_watchlist',
        'added_to_favorites',
        'marked_watched',
        'rated_title',
        'reviewed_title',
        'followed_user'
    );

    -- ========================================================================
    -- 3. Watchlist Items Mapping Validation & Transition
    -- ========================================================================
    SELECT count(*) INTO v_count FROM "watchlist_items";

    -- Check for optional prepared columns on watchlist_items
    SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'watchlist_items' AND column_name = 'tmdbId';
    IF FOUND THEN
        IF v_col.data_type <> 'integer' OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
            RAISE EXCEPTION 'Incompatible column watchlist_items.tmdbId: expected nullable integer with no default.';
        END IF;
        v_prep_tmdbId_exists := true;
    ELSE
        v_prep_tmdbId_exists := false;
    END IF;

    SELECT data_type, udt_name, is_nullable, column_default INTO v_col
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'watchlist_items' AND column_name = 'mediaType';
    IF FOUND THEN
        -- Verify exact enum identity
        IF NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_type t ON t.oid = a.atttypid
            JOIN pg_namespace tn ON tn.oid = t.typnamespace
            WHERE n.nspname = 'public' AND c.relname = 'watchlist_items' AND a.attname = 'mediaType'
              AND tn.nspname = 'public' AND t.typname = 'TmdbMediaType' AND t.typtype = 'e'
        ) OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
            RAISE EXCEPTION 'Incompatible column watchlist_items.mediaType: expected nullable public.TmdbMediaType with no default.';
        END IF;
        v_prep_mediaType_exists := true;
    ELSE
        v_prep_mediaType_exists := false;
    END IF;

    -- Legacy rows validation
    IF v_count > 0 THEN
        IF NOT v_prep_tmdbId_exists OR NOT v_prep_mediaType_exists THEN
            RAISE EXCEPTION 'Cannot migrate watchlist_items: % existing legacy rows are unmapped. Run scripts/prepare-legacy-watchlist.sql and populate authoritative TMDB mappings by row ID before migrating.', v_count;
        END IF;

        -- Check for unmapped rows
        SELECT count(*) INTO v_count FROM "watchlist_items" WHERE "tmdbId" IS NULL OR "mediaType" IS NULL;
        IF v_count > 0 THEN
            RAISE EXCEPTION 'Cannot migrate watchlist_items: % row(s) have NULL tmdbId or NULL mediaType. All legacy rows must be authoritatively mapped.', v_count;
        END IF;

        -- Check for duplicates on (userId, tmdbId, mediaType)
        SELECT count(*) INTO v_count FROM (
            SELECT "userId", "tmdbId", "mediaType"
            FROM "watchlist_items"
            GROUP BY "userId", "tmdbId", "mediaType"
            HAVING count(*) > 1
        ) d;
        IF v_count > 0 THEN
            RAISE EXCEPTION 'Cannot migrate watchlist_items: duplicate (userId, tmdbId, mediaType) rows detected.';
        END IF;
    END IF;

    -- ========================================================================
    -- 4. Execute DDL Operations
    -- ========================================================================
    -- 4a. Update users table
    ALTER TABLE "users"
        ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN "image" TEXT,
        ADD COLUMN "username" VARCHAR(30),
        ADD COLUMN "bio" VARCHAR(500),
        ADD COLUMN "isWatchlistPublic" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN "isActivityPublic" BOOLEAN NOT NULL DEFAULT true,
        ALTER COLUMN "name" SET NOT NULL,
        ALTER COLUMN "email" SET NOT NULL;

    CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
    CREATE INDEX "users_name_idx" ON "users"("name");

    -- 4b. Update watchlist_items table
    IF NOT v_prep_tmdbId_exists THEN
        ALTER TABLE "watchlist_items" ADD COLUMN "tmdbId" INTEGER NOT NULL;
    ELSE
        ALTER TABLE "watchlist_items" ALTER COLUMN "tmdbId" SET NOT NULL;
    END IF;

    IF NOT v_prep_mediaType_exists THEN
        ALTER TABLE "watchlist_items" ADD COLUMN "mediaType" "TmdbMediaType" NOT NULL;
    ELSE
        ALTER TABLE "watchlist_items" ALTER COLUMN "mediaType" SET NOT NULL;
    END IF;

    ALTER TABLE "watchlist_items" ALTER COLUMN "titleId" DROP NOT NULL;

    ALTER TABLE "watchlist_items" DROP CONSTRAINT "watchlist_items_titleId_fkey";
    ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_titleId_fkey"
        FOREIGN KEY ("titleId") REFERENCES "titles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

    DROP INDEX "watchlist_items_userId_titleId_key";
    CREATE UNIQUE INDEX "watchlist_items_userId_tmdbId_mediaType_key" ON "watchlist_items"("userId", "tmdbId", "mediaType");

    -- 4c. Update account table
    CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

    -- 4d. Create modern tables, indexes, and foreign keys
    CREATE TABLE "favorites" (
        "id" SERIAL NOT NULL,
        "userId" INTEGER NOT NULL,
        "tmdbId" INTEGER NOT NULL,
        "mediaType" "TmdbMediaType" NOT NULL,
        "featuredRank" INTEGER,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "favorites_userId_featuredRank_idx" ON "favorites"("userId", "featuredRank");
    CREATE UNIQUE INDEX "favorites_userId_tmdbId_mediaType_key" ON "favorites"("userId", "tmdbId", "mediaType");
    ALTER TABLE "favorites" ADD CONSTRAINT "favorites_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    CREATE TABLE "follows" (
        "id" SERIAL NOT NULL,
        "followerId" INTEGER NOT NULL,
        "followingId" INTEGER NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "follows_followingId_idx" ON "follows"("followingId");
    CREATE INDEX "follows_followerId_idx" ON "follows"("followerId");
    CREATE UNIQUE INDEX "follows_followerId_followingId_key" ON "follows"("followerId", "followingId");
    ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey"
        FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "follows" ADD CONSTRAINT "follows_followingId_fkey"
        FOREIGN KEY ("followingId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    CREATE TABLE "comments" (
        "id" SERIAL NOT NULL,
        "userId" INTEGER NOT NULL,
        "tmdbId" INTEGER NOT NULL,
        "mediaType" "TmdbMediaType" NOT NULL,
        "parentId" INTEGER,
        "body" VARCHAR(2000) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        "deletedAt" TIMESTAMP(3),

        CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "comments_tmdbId_mediaType_parentId_createdAt_idx" ON "comments"("tmdbId", "mediaType", "parentId", "createdAt");
    CREATE INDEX "comments_userId_idx" ON "comments"("userId");
    ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey"
        FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    CREATE TABLE "activities" (
        "id" SERIAL NOT NULL,
        "userId" INTEGER NOT NULL,
        "type" "ActivityType" NOT NULL,
        "tmdbId" INTEGER,
        "mediaType" "TmdbMediaType",
        "metadata" JSONB,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "activities_userId_createdAt_idx" ON "activities"("userId", "createdAt");
    CREATE INDEX "activities_createdAt_idx" ON "activities"("createdAt");
    ALTER TABLE "activities" ADD CONSTRAINT "activities_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

END $migration$;
