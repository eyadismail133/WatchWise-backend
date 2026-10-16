import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

function sanitize(msg: string): string {
  if (!msg) return "";
  return msg.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, "$1***$3");
}

function formatError(err: unknown): string {
  if (err instanceof Error) return sanitize(err.message);
  return sanitize(String(err));
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

// ----------------------------------------------------------------------------
// Early Environment & Loopback Validation (BEFORE ANY DB ACCESS)
// ----------------------------------------------------------------------------
export function validateAdminUrl(raw?: string): URL {
  if (!raw || !raw.trim()) {
    throw new Error("MIGRATION_TEST_ADMIN_URL environment variable is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("MIGRATION_TEST_ADMIN_URL is malformed.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`Invalid protocol "${parsed.protocol}", expected postgres: or postgresql:`);
  }

  if (parsed.search && parsed.search !== "") {
    throw new Error("URL query parameters are strictly forbidden in MIGRATION_TEST_ADMIN_URL.");
  }

  if (parsed.hash && parsed.hash !== "") {
    throw new Error("URL hash fragments are strictly forbidden in MIGRATION_TEST_ADMIN_URL.");
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]";

  if (!isLoopback) {
    throw new Error(`Host "${host}" is not a loopback address. Refusing connection for safety.`);
  }

  return parsed;
}

// Harmless, no-network unit tests for URL validation
function testValidateAdminUrl(): void {
  assert.throws(() => validateAdminUrl(undefined), /required/);
  assert.throws(() => validateAdminUrl(""), /required/);
  assert.throws(() => validateAdminUrl("http://localhost:5432/postgres"), /Invalid protocol/);
  assert.throws(() => validateAdminUrl("postgresql://remote.example.com/db"), /not a loopback/);
  assert.throws(() => validateAdminUrl("postgresql://127.0.0.1:5432/db?host=remote.example"), /query parameters/);
  assert.throws(() => validateAdminUrl("postgresql://127.0.0.1:5432/db?password=secret"), /query parameters/);
  assert.throws(() => validateAdminUrl("postgresql://127.0.0.1:5432/db#fragment"), /hash fragments/);
  const ok = validateAdminUrl("postgresql://user:pass@127.0.0.1:5432/postgres");
  assert.strictEqual(ok.hostname, "127.0.0.1");
}

testValidateAdminUrl();

let parsedAdminUrl: URL;
try {
  parsedAdminUrl = validateAdminUrl(process.env.MIGRATION_TEST_ADMIN_URL);
} catch (err: unknown) {
  console.error("Error:", formatError(err));
  console.error("Set MIGRATION_TEST_ADMIN_URL to a PostgreSQL admin connection string on a loopback host (127.0.0.1 or localhost) with no query parameters.");
  console.error("Example: MIGRATION_TEST_ADMIN_URL=postgresql://postgres:password@127.0.0.1:5432/postgres");
  process.exit(1);
}
const createdDatabases = new Set<string>();

function runPrisma(args: string[], dbUrl: string): { stdout: string; stderr: string; status: number } {
  const prismaBin = path.resolve("node_modules/prisma/build/index.js");
  const childEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
  };

  const res = spawnSync(process.execPath, [prismaBin, ...args], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
    windowsHide: true,
  });

  const status =
    res.error != null || res.signal != null
      ? -1
      : (res.status ?? -1);

  const extraErr = [
    res.error ? `spawn error: ${res.error.message}` : "",
    res.signal ? `terminated by signal: ${res.signal}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return {
    stdout: res.stdout || "",
    stderr: [res.stderr || "", extraErr].filter(Boolean).join("\n"),
    status,
  };
}

async function createDisposableDb(
  adminClient: pg.Client,
  tag: string
): Promise<{ dbName: string; dbUrl: string }> {
  const rand = Math.random().toString(36).substring(2, 8);
  const dbName = `watchwise_migration_${tag}_${Date.now()}_${rand}`.toLowerCase();
  await adminClient.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  createdDatabases.add(dbName);

  const targetUrl = new URL(parsedAdminUrl.toString());
  targetUrl.pathname = `/${dbName}`;
  return { dbName, dbUrl: targetUrl.toString() };
}

async function dropDisposableDb(adminClient: pg.Client, dbName: string): Promise<void> {
  if (!createdDatabases.has(dbName)) {
    throw new Error(`Safety violation: refusing to drop untracked database: ${dbName}`);
  }
  await adminClient.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName]
  );
  await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
  createdDatabases.delete(dbName);
}

function assertSchemaMatches(dbUrl: string, schemaPath: string, context: string): void {
  const res = runPrisma(
    ["migrate", "diff", "--from-config-datasource", "--to-schema", schemaPath, "--exit-code"],
    dbUrl
  );
  if (res.status !== 0) {
    throw new Error(
      `Schema drift detected in ${context} against ${schemaPath} (exit code ${res.status}):\n${sanitize(res.stdout + "\n" + res.stderr)}`
    );
  }
}

// ----------------------------------------------------------------------------
// Full Application Catalog, Sequences & Data Snapshots
// ----------------------------------------------------------------------------
interface SequenceSnapshot {
  seq_name: string;
  data_type: string;
  start_value: string;
  min_value: string;
  max_value: string;
  increment_by: string;
  cycle: boolean;
  cache_size: string;
  owned_by_table: string | null;
  owned_by_column: string | null;
  last_value: string;
  is_called: boolean;
}

interface CatalogSnapshot {
  tables: string[];
  columns: Array<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
    data_type: string;
    udt_schema: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
    datetime_precision: number | null;
  }>;
  indexes: Array<{
    index_name: string;
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    is_valid: boolean;
    is_partial: boolean;
    cols: string[];
    indexdef: string;
  }>;
  constraints: Array<{
    conname: string;
    table_name: string;
    contype: string;
    is_validated: boolean;
    is_deferrable: boolean;
    is_deferred: boolean;
    condef: string;
    ref_schema: string | null;
    ref_table: string | null;
    updtype: string | null;
    deltype: string | null;
    matchtype: string | null;
    src_cols: string[] | null;
    ref_cols: string[] | null;
  }>;
  enums: Array<{
    typname: string;
    labels: string[];
  }>;
  sequences: SequenceSnapshot[];
}

async function getCatalogSnapshot(client: pg.Client): Promise<CatalogSnapshot> {
  const tRes = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`
  );

  const cRes = await client.query(
    `SELECT
       table_name,
       column_name,
       ordinal_position,
       data_type,
       udt_schema,
       udt_name,
       is_nullable,
       column_default,
       character_maximum_length,
       numeric_precision,
       numeric_scale,
       datetime_precision
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
     ORDER BY table_name, ordinal_position`
  );

  const iRes = await client.query(
    `SELECT
       c.relname AS index_name,
       tbl.relname AS table_name,
       i.indisunique AS is_unique,
       i.indisprimary AS is_primary,
       i.indisvalid AS is_valid,
       (i.indpred IS NOT NULL) AS is_partial,
       array_agg(att.attname::text ORDER BY k.pos) AS cols,
       pg_get_indexdef(c.oid) AS indexdef
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_class tbl ON tbl.oid = i.indrelid
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, pos)
     JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
     WHERE n.nspname = 'public' AND tbl.relname <> '_prisma_migrations'
     GROUP BY c.oid, c.relname, tbl.relname, i.indisunique, i.indisprimary, i.indisvalid, i.indpred
     ORDER BY c.relname`
  );

  const conRes = await client.query(
    `SELECT
       c.conname,
       src.relname AS table_name,
       c.contype::text AS contype,
       c.convalidated AS is_validated,
       c.condeferrable AS is_deferrable,
       c.condeferred AS is_deferred,
       pg_get_constraintdef(c.oid, true) AS condef,
       ref_ns.nspname AS ref_schema,
       ref.relname AS ref_table,
       CASE WHEN c.contype = 'f' THEN c.confupdtype::text ELSE NULL END AS updtype,
       CASE WHEN c.contype = 'f' THEN c.confdeltype::text ELSE NULL END AS deltype,
       CASE WHEN c.contype = 'f' THEN c.confmatchtype::text ELSE NULL END AS matchtype,
       (SELECT array_agg(att.attname::text ORDER BY k.pos)
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, pos)
        JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS src_cols,
       CASE WHEN c.contype = 'f' THEN
         (SELECT array_agg(att.attname::text ORDER BY k.pos)
          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, pos)
          JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = k.attnum)
       ELSE NULL END AS ref_cols
     FROM pg_constraint c
     JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = src.relnamespace
     LEFT JOIN pg_class ref ON ref.oid = c.confrelid
     LEFT JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
     WHERE n.nspname = 'public' AND src.relname <> '_prisma_migrations'
     ORDER BY src.relname, c.conname`
  );

  const eRes = await client.query(
    `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'public'
     GROUP BY t.typname
     ORDER BY t.typname`
  );

  const seqMetaRes = await client.query<{
    seq_name: string;
    data_type: string;
    start_value: string;
    min_value: string;
    max_value: string;
    increment_by: string;
    cycle: boolean;
    cache_size: string;
    owned_by_table: string | null;
    owned_by_column: string | null;
  }>(
    `SELECT
       s.sequencename AS seq_name,
       s.data_type::text AS data_type,
       s.start_value::text AS start_value,
       s.min_value::text AS min_value,
       s.max_value::text AS max_value,
       s.increment_by::text AS increment_by,
       s.cycle,
       s.cache_size::text AS cache_size,
       tbl.relname AS owned_by_table,
       att.attname AS owned_by_column
     FROM pg_sequences s
     JOIN pg_namespace n ON n.nspname = s.schemaname
     JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename AND c.relkind = 'S'
     LEFT JOIN pg_depend d
       ON d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.refclassid = 'pg_class'::regclass
      AND d.deptype IN ('a', 'i')
     LEFT JOIN pg_class tbl ON tbl.oid = d.refobjid
     LEFT JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = d.refobjsubid
     WHERE s.schemaname = 'public'
     ORDER BY s.sequencename`
  );

  const sequences: SequenceSnapshot[] = [];
  for (const meta of seqMetaRes.rows) {
    const seqStateRes = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text AS last_value, is_called FROM "public".${quoteIdent(meta.seq_name)}`
    );
    sequences.push({
      ...meta,
      last_value: seqStateRes.rows[0].last_value,
      is_called: seqStateRes.rows[0].is_called,
    });
  }

  return {
    tables: tRes.rows.map((r) => r.tablename),
    columns: cRes.rows,
    indexes: iRes.rows,
    constraints: conRes.rows,
    enums: eRes.rows,
    sequences,
  };
}

async function getAppDataSnapshot(client: pg.Client): Promise<Record<string, Array<Record<string, unknown>>>> {
  const tRes = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`
  );
  const snapshot: Record<string, Array<Record<string, unknown>>> = {};
  for (const r of tRes.rows) {
    const tbl = r.tablename;
    const rows = await client.query<Record<string, unknown>>(
      `SELECT * FROM "public".${quoteIdent(tbl)} ORDER BY 1 ASC`
    );
    snapshot[tbl] = rows.rows;
  }
  return snapshot;
}

const MIGRATION_1_SQL = fs.readFileSync(
  path.resolve("prisma/migrations/20260519065127_init/migration.sql"),
  "utf8"
);
const MIGRATION_2_SQL = fs.readFileSync(
  path.resolve("prisma/migrations/20260519070248_init/migration.sql"),
  "utf8"
);
const MIGRATION_3_SQL = fs.readFileSync(
  path.resolve("prisma/migrations/20260519202115_init/migration.sql"),
  "utf8"
);

// ============================================================================
// Scenario A: Fresh Empty DB Deploy -> Full 4-Chain -> Zero Prisma Diff -> No-op
// ============================================================================
async function runScenarioA(adminClient: pg.Client): Promise<void> {
  console.log("\n--- Scenario A: Fresh Empty DB Deploy (Full 4-Chain) ---");
  const { dbName, dbUrl } = await createDisposableDb(adminClient, "scen_a");
  try {
    const deploy1 = runPrisma(["migrate", "deploy"], dbUrl);
    if (deploy1.status !== 0) {
      throw new Error(`Scenario A: migrate deploy failed:\n${sanitize(deploy1.stderr || deploy1.stdout)}`);
    }

    assertSchemaMatches(dbUrl, "prisma/schema.prisma", "Scenario A after initial deploy");

    const deploy2 = runPrisma(["migrate", "deploy"], dbUrl);
    if (deploy2.status !== 0) {
      throw new Error(`Scenario A: second migrate deploy failed:\n${sanitize(deploy2.stderr || deploy2.stdout)}`);
    }

    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const now = new Date("2026-10-16T00:00:00.000Z");

      const u1 = await client.query(
        `INSERT INTO "users" ("name", "email", "updatedAt") VALUES ($1, $2, $3) RETURNING "id", "emailVerified", "role", "subscriptionStatus", "isWatchlistPublic", "isActivityPublic"`,
        ["Alice", "alice@example.com", now]
      );
      if (u1.rows[0].id !== 1 || u1.rows[0].emailVerified !== false || u1.rows[0].isWatchlistPublic !== true) {
        throw new Error(`Scenario A: unexpected defaults on inserted user: ${JSON.stringify(u1.rows[0])}`);
      }

      const u2 = await client.query(
        `INSERT INTO "users" ("name", "email", "updatedAt") VALUES ($1, $2, $3) RETURNING "id"`,
        ["Bob", "bob@example.com", now]
      );
      if (u2.rows[0].id !== 2) {
        throw new Error(`Scenario A: expected user sequence id 2, got ${u2.rows[0].id}`);
      }

      const t1 = await client.query(
        `INSERT INTO "titles" ("title", "type") VALUES ($1, $2) RETURNING "id", "popularityScore"`,
        ["Inception", "movie"]
      );
      if (t1.rows[0].id !== 1 || t1.rows[0].popularityScore !== 50) {
        throw new Error(`Scenario A: unexpected defaults on inserted title: ${JSON.stringify(t1.rows[0])}`);
      }

      const w1 = await client.query(
        `INSERT INTO "watchlist_items" ("userId", "tmdbId", "mediaType", "titleId", "updatedAt") VALUES ($1, $2, $3, $4, $5) RETURNING "id", "status"`,
        [1, 27205, "movie", 1, now]
      );
      if (w1.rows[0].id !== 1 || w1.rows[0].status !== "want_to_watch") {
        throw new Error(`Scenario A: unexpected defaults on inserted watchlist_item: ${JSON.stringify(w1.rows[0])}`);
      }

      const f1 = await client.query(
        `INSERT INTO "favorites" ("userId", "tmdbId", "mediaType") VALUES ($1, $2, $3) RETURNING "id"`,
        [1, 27205, "movie"]
      );
      if (f1.rows[0].id !== 1) throw new Error("Scenario A: favorite insert failed");

      const fol1 = await client.query(
        `INSERT INTO "follows" ("followerId", "followingId") VALUES ($1, $2) RETURNING "id"`,
        [1, 2]
      );
      if (fol1.rows[0].id !== 1) throw new Error("Scenario A: follow insert failed");

      const c1 = await client.query(
        `INSERT INTO "comments" ("userId", "tmdbId", "mediaType", "body", "updatedAt") VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
        [1, 27205, "movie", "Great film!", now]
      );
      if (c1.rows[0].id !== 1) throw new Error("Scenario A: comment insert failed");

      const a1 = await client.query(
        `INSERT INTO "activities" ("userId", "type", "tmdbId", "mediaType") VALUES ($1, $2, $3, $4) RETURNING "id"`,
        [1, "added_to_watchlist", 27205, "movie"]
      );
      if (a1.rows[0].id !== 1) throw new Error("Scenario A: activity insert failed");
    } finally {
      await client.end();
    }

    console.log("✔ Scenario A passed");
  } finally {
    await dropDisposableDb(adminClient, dbName);
  }
}

// ============================================================================
// Scenario B: Historical Replay & Legacy Upgrade with Authoritative Mapping
// ============================================================================
async function runScenarioB(adminClient: pg.Client): Promise<void> {
  console.log("\n--- Scenario B: Legacy Replay, Preflight, Guarded Rollback & Upgrade ---");
  const { dbName, dbUrl } = await createDisposableDb(adminClient, "scen_b");
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query(MIGRATION_1_SQL);
      await client.query(MIGRATION_2_SQL);
      await client.query(MIGRATION_3_SQL);

      // Verify that original 3 replay has EXACT ZERO DIFF against scripts/legacy-schema.prisma
      assertSchemaMatches(dbUrl, "scripts/legacy-schema.prisma", "Scenario B original 3 replay");

      const r1 = runPrisma(["migrate", "resolve", "--applied", "20260519065127_init"], dbUrl);
      const r2 = runPrisma(["migrate", "resolve", "--applied", "20260519070248_init"], dbUrl);
      const r3 = runPrisma(["migrate", "resolve", "--applied", "20260519202115_init"], dbUrl);
      if (r1.status !== 0 || r2.status !== 0 || r3.status !== 0) {
        throw new Error(
          `Scenario B: resolving original migrations failed: ${sanitize(r1.stderr || r2.stderr || r3.stderr)}`
        );
      }

      const now = new Date("2026-10-16T00:00:00.000Z");
      const expires = new Date("2026-10-23T00:00:00.000Z");

      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "avatar", "createdAt", "updatedAt", "lastSignInAt", "role", "subscriptionStatus") VALUES
         (1, 'Alice Legacy', 'alice@legacy.example.com', 'https://example.com/a.png', $1, $1, $1, 'user', 'free'),
         (2, 'Bob Legacy', 'bob@legacy.example.com', NULL, $1, $1, $1, 'admin', 'premium')`,
        [now]
      );
      await client.query(`SELECT setval('users_id_seq', (SELECT MAX(id) FROM "users"))`);

      await client.query(
        `INSERT INTO "titles" ("id", "title", "type", "description", "releaseYear", "createdAt") VALUES
         (10, 'Inception', 'movie', 'Dream world', 2010, $1),
         (20, 'Breaking Bad', 'series', 'Chemistry teacher', 2008, $1)`,
        [now]
      );
      await client.query(`SELECT setval('titles_id_seq', (SELECT MAX(id) FROM "titles"))`);

      await client.query(
        `INSERT INTO "watchlist_items" ("id", "userId", "titleId", "status", "userRating", "tags", "notes", "createdAt", "updatedAt") VALUES
         (101, 1, 10, 'watched', 5, '["sci-fi","thriller"]'::jsonb, 'Loved it', $1, $1),
         (102, 2, 20, 'want_to_watch', NULL, NULL, 'Queue', $1, $1)`,
        [now]
      );
      await client.query(`SELECT setval('watchlist_items_id_seq', (SELECT MAX(id) FROM "watchlist_items"))`);

      await client.query(
        `INSERT INTO "taste_profiles" ("id", "userId", "favoriteGenres", "averageRating", "aiSummary", "updatedAt") VALUES
         (1, 1, '["Sci-Fi"]'::jsonb, 4.5, 'Loves complex plots', $1)`,
        [now]
      );
      await client.query(`SELECT setval('taste_profiles_id_seq', 1)`);

      await client.query(
        `INSERT INTO "recommendations" ("id", "userId", "titleId", "explanation", "confidence", "isHiddenGem", "userFeedback", "createdAt") VALUES
         (1, 1, 10, 'Mind-bending', 0.95, 'no', 'positive', $1)`,
        [now]
      );
      await client.query(`SELECT setval('recommendations_id_seq', 1)`);

      await client.query(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId") VALUES
         ('sess-legacy-1', $2, 'tok-legacy-abc', $1, $1, '127.0.0.1', 'TestAgent/1.0', 1)`,
        [now, expires]
      );
      await client.query(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "accessTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") VALUES
         ('acc-legacy-1', 'acc-id-1', 'credentials', 1, 'acc-tok-1', 'ref-tok-1', $2, 'read:user', 'hashed-pw-1', $1, $1)`,
        [now, expires]
      );
      await client.query(
        `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES
         ('ver-legacy-1', 'ident-1', 'val-1', $2, $1, $1)`,
        [now, expires]
      );

      // Snapshot full catalog and all data before attempt
      const catBefore = await getCatalogSnapshot(client);
      const dataBefore = await getAppDataSnapshot(client);

      // Deploy MUST FAIL because legacy watchlist rows are unmapped
      const failedDeploy = runPrisma(["migrate", "deploy"], dbUrl);
      if (failedDeploy.status === 0) {
        throw new Error("Scenario B: deploy should have failed on unmapped legacy rows, but succeeded!");
      }
      const combinedErr = failedDeploy.stderr + "\n" + failedDeploy.stdout;
      if (!combinedErr.includes("Cannot migrate watchlist_items")) {
        throw new Error(`Scenario B: unexpected failure message:\n${sanitize(combinedErr)}`);
      }

      // Snapshot full catalog and all data after failed attempt
      const catAfterFail = await getCatalogSnapshot(client);
      const dataAfterFail = await getAppDataSnapshot(client);

      // Prove complete atomic rollback before resolving failed metadata
      assert.deepStrictEqual(
        catAfterFail,
        catBefore,
        "Scenario B: Application catalog mutated during rolled-back migration!"
      );
      assert.deepStrictEqual(
        dataAfterFail,
        dataBefore,
        "Scenario B: Application data mutated during rolled-back migration!"
      );

      // Apply preparation artifact
      const prepSql = fs.readFileSync(path.resolve("scripts/prepare-legacy-watchlist.sql"), "utf8");
      await client.query(prepSql);

      // Apply authoritative mappings (titleId 10 -> TMDB 27205, titleId 20 -> TMDB 1396)
      // Keep internal title IDs distinct from TMDB IDs!
      await client.query(
        `UPDATE "watchlist_items" SET "tmdbId" = 27205, "mediaType" = 'movie'::"TmdbMediaType" WHERE "id" = 101;`
      );
      await client.query(
        `UPDATE "watchlist_items" SET "tmdbId" = 1396, "mediaType" = 'tv'::"TmdbMediaType" WHERE "id" = 102;`
      );

      // Mark failed migration as rolled back ONLY after proving atomic rollback
      const resolveRolledBack = runPrisma(
        ["migrate", "resolve", "--rolled-back", "20261016000000_repair_schema"],
        dbUrl
      );
      if (resolveRolledBack.status !== 0) {
        throw new Error(
          `Scenario B: failed to resolve rolled back migration:\n${sanitize(resolveRolledBack.stderr || resolveRolledBack.stdout)}`
        );
      }

      // Rerun deploy -> MUST SUCCEED
      const retryDeploy = runPrisma(["migrate", "deploy"], dbUrl);
      if (retryDeploy.status !== 0) {
        throw new Error(`Scenario B: retry deploy failed:\n${sanitize(retryDeploy.stderr || retryDeploy.stdout)}`);
      }

      assertSchemaMatches(dbUrl, "prisma/schema.prisma", "Scenario B after retry deploy");

      // Capture full post-upgrade catalog and application data BEFORE intentional mutations
      const catAfterUpgrade = await getCatalogSnapshot(client);
      const dataAfterUpgrade = await getAppDataSnapshot(client);

      // 1. Compare ALL original column projections of EVERY original row across all 8 legacy tables
      for (const tbl of Object.keys(dataBefore)) {
        const beforeRows = dataBefore[tbl];
        const afterRows = dataAfterUpgrade[tbl];
        assert.ok(afterRows, `Scenario B: Table "${tbl}" missing after upgrade!`);
        assert.strictEqual(
          afterRows.length,
          beforeRows.length,
          `Scenario B: Row count changed on table "${tbl}" during upgrade!`
        );

        const projectedAfter = afterRows.map((afterRow, idx) => {
          const origRow = beforeRows[idx];
          const proj: Record<string, unknown> = {};
          for (const col of Object.keys(origRow)) {
            proj[col] = afterRow[col];
          }
          return proj;
        });

        assert.deepStrictEqual(
          projectedAfter,
          beforeRows,
          `Scenario B: Original columns on table "${tbl}" were altered during upgrade!`
        );
      }

      // 2. Verify intended new columns & defaults on users and mapped columns on watchlist_items
      for (const uRow of dataAfterUpgrade["users"]) {
        assert.strictEqual(uRow.emailVerified, false, "Scenario B: expected emailVerified default false");
        assert.strictEqual(uRow.image, null, "Scenario B: expected image default null");
        assert.strictEqual(uRow.username, null, "Scenario B: expected username default null");
        assert.strictEqual(uRow.bio, null, "Scenario B: expected bio default null");
        assert.strictEqual(uRow.isWatchlistPublic, true, "Scenario B: expected isWatchlistPublic default true");
        assert.strictEqual(uRow.isActivityPublic, true, "Scenario B: expected isActivityPublic default true");
      }

      const wlAfter = dataAfterUpgrade["watchlist_items"];
      assert.strictEqual(wlAfter[0].id, 101);
      assert.strictEqual(wlAfter[0].titleId, 10);
      assert.strictEqual(wlAfter[0].tmdbId, 27205);
      assert.strictEqual(wlAfter[0].mediaType, "movie");
      assert.strictEqual(wlAfter[1].id, 102);
      assert.strictEqual(wlAfter[1].titleId, 20);
      assert.strictEqual(wlAfter[1].tmdbId, 1396);
      assert.strictEqual(wlAfter[1].mediaType, "tv");

      // 3. Verify all original sequences preserved state, parameters, and ownership exactly
      const afterSeqMap = new Map(catAfterUpgrade.sequences.map((s) => [s.seq_name, s]));
      for (const origSeq of catBefore.sequences) {
        const afterSeq = afterSeqMap.get(origSeq.seq_name);
        assert.ok(afterSeq, `Scenario B: Original sequence "${origSeq.seq_name}" missing after upgrade!`);
        assert.deepStrictEqual(
          afterSeq,
          origSeq,
          `Scenario B: Original sequence "${origSeq.seq_name}" mutated during upgrade!`
        );
      }
      for (const newSeqName of ["favorites_id_seq", "follows_id_seq", "comments_id_seq", "activities_id_seq"]) {
        assert.ok(afterSeqMap.has(newSeqName), `Scenario B: Expected new sequence "${newSeqName}" to exist`);
      }

      // 4. Test FK behavior: ON DELETE SET NULL on titleId
      await client.query(`DELETE FROM "titles" WHERE "id" = 20`);
      const wlCheckNull = await client.query(`SELECT "titleId", "tmdbId", "mediaType" FROM "watchlist_items" WHERE "id" = 102`);
      assert.strictEqual(wlCheckNull.rows[0].titleId, null, "Scenario B: titleId was not set to NULL upon deleting referenced title!");
      assert.strictEqual(wlCheckNull.rows[0].tmdbId, 1396, "Scenario B: tmdbId changed after deleting internal title!");
      assert.strictEqual(wlCheckNull.rows[0].mediaType, "tv", "Scenario B: mediaType changed after deleting internal title!");

      // 5. Verify sequence advancement on subsequent insert
      const nextUser = await client.query(
        `INSERT INTO "users" ("name", "email", "updatedAt") VALUES ('Charlie', 'charlie@legacy.example.com', $1) RETURNING "id"`,
        [now]
      );
      assert.strictEqual(nextUser.rows[0].id, 3, "Scenario B: users serial sequence did not advance to 3");
    } finally {
      await client.end();
    }

    console.log("✔ Scenario B passed");
  } finally {
    await dropDisposableDb(adminClient, dbName);
  }
}

// ============================================================================
// Scenario C: Modern Schema History Reconciliation (Prisma 7 Hotfix Workflow)
// ============================================================================
async function runScenarioC(adminClient: pg.Client): Promise<void> {
  console.log("\n--- Scenario C: Modern Schema Reconciliation (resolve --applied + deploy no-op) ---");
  const { dbName, dbUrl } = await createDisposableDb(adminClient, "scen_c");
  try {
    const diffScript = runPrisma(
      ["migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
      dbUrl
    );
    if (diffScript.status !== 0) {
      throw new Error(`Scenario C: failed to generate current schema DDL:\n${sanitize(diffScript.stderr)}`);
    }

    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query(diffScript.stdout);

      // Baseline with original 3 migrations
      const r1 = runPrisma(["migrate", "resolve", "--applied", "20260519065127_init"], dbUrl);
      const r2 = runPrisma(["migrate", "resolve", "--applied", "20260519070248_init"], dbUrl);
      const r3 = runPrisma(["migrate", "resolve", "--applied", "20260519202115_init"], dbUrl);
      if (r1.status !== 0 || r2.status !== 0 || r3.status !== 0) {
        throw new Error(
          `Scenario C: resolving original migrations failed: ${sanitize(r1.stderr || r2.stderr || r3.stderr)}`
        );
      }

      assertSchemaMatches(dbUrl, "prisma/schema.prisma", "Scenario C baseline modern schema");

      const now = new Date("2026-10-16T00:00:00.000Z");
      const expires = new Date("2026-10-23T00:00:00.000Z");

      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "emailVerified", "image", "avatar", "username", "bio", "isWatchlistPublic", "isActivityPublic", "createdAt", "updatedAt", "lastSignInAt") VALUES
         (1, 'Modern User', 'modern@example.com', true, 'https://example.com/img1.png', 'https://example.com/av1.png', 'moduser', 'Custom bio', false, false, $1, $1, $1),
         (2, 'Friend User', 'friend@example.com', true, NULL, NULL, 'frienduser', 'Friend bio', true, true, $1, $1, $1)`,
        [now]
      );
      await client.query(`SELECT setval('users_id_seq', (SELECT MAX(id) FROM "users"))`);

      await client.query(
        `INSERT INTO "titles" ("id", "title", "type", "description", "createdAt") VALUES
         (1, 'Modern Movie', 'movie', 'A modern classic', $1)`,
        [now]
      );
      await client.query(`SELECT setval('titles_id_seq', (SELECT MAX(id) FROM "titles"))`);

      await client.query(
        `INSERT INTO "watchlist_items" ("id", "userId", "titleId", "tmdbId", "mediaType", "status", "userRating", "notes", "createdAt", "updatedAt") VALUES
         (1, 1, 1, 550, 'movie', 'watched', 5, 'Must watch', $1, $1)`,
        [now]
      );
      await client.query(`SELECT setval('watchlist_items_id_seq', (SELECT MAX(id) FROM "watchlist_items"))`);

      await client.query(
        `INSERT INTO "taste_profiles" ("id", "userId", "favoriteGenres", "averageRating", "aiSummary", "updatedAt") VALUES
         (1, 1, '["Drama","Thriller"]'::jsonb, 4.8, 'Arthouse fan', $1)`,
        [now]
      );
      await client.query(`SELECT setval('taste_profiles_id_seq', (SELECT MAX(id) FROM "taste_profiles"))`);

      await client.query(
        `INSERT INTO "recommendations" ("id", "userId", "titleId", "explanation", "confidence", "isHiddenGem", "userFeedback", "createdAt") VALUES
         (1, 1, 1, 'Fits profile', 0.92, 'yes', 'positive', $1)`,
        [now]
      );
      await client.query(`SELECT setval('recommendations_id_seq', (SELECT MAX(id) FROM "recommendations"))`);

      await client.query(
        `INSERT INTO "favorites" ("id", "userId", "tmdbId", "mediaType", "featuredRank", "createdAt") VALUES
         (1, 1, 550, 'movie', 1, $1)`,
        [now]
      );
      await client.query(`SELECT setval('favorites_id_seq', (SELECT MAX(id) FROM "favorites"))`);

      await client.query(
        `INSERT INTO "follows" ("id", "followerId", "followingId", "createdAt") VALUES
         (1, 1, 2, $1)`,
        [now]
      );
      await client.query(`SELECT setval('follows_id_seq', (SELECT MAX(id) FROM "follows"))`);

      await client.query(
        `INSERT INTO "comments" ("id", "userId", "tmdbId", "mediaType", "body", "createdAt", "updatedAt") VALUES
         (1, 1, 550, 'movie', 'Great modern film!', $1, $1)`,
        [now]
      );
      await client.query(`SELECT setval('comments_id_seq', (SELECT MAX(id) FROM "comments"))`);

      await client.query(
        `INSERT INTO "activities" ("id", "userId", "type", "tmdbId", "mediaType", "metadata", "createdAt") VALUES
         (1, 1, 'marked_watched', 550, 'movie', '{"rating":5}'::jsonb, $1)`,
        [now]
      );
      await client.query(`SELECT setval('activities_id_seq', (SELECT MAX(id) FROM "activities"))`);

      await client.query(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId") VALUES
         ('sess-mod-1', $2, 'tok-modern-xyz', $1, $1, '127.0.0.1', 'Mozilla/5.0', 1)`,
        [now, expires]
      );
      await client.query(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "accessTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") VALUES
         ('acc-mod-1', 'acc-mod-id', 'oauth-provider', 1, 'oauth-access-1', 'oauth-refresh-1', $2, 'profile email', NULL, $1, $1)`,
        [now, expires]
      );
      await client.query(
        `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES
         ('ver-mod-1', 'modern@example.com', 'ver-code-999', $2, $1, $1)`,
        [now, expires]
      );

      // Deep snapshot of catalog (including sequences) and all 12 model tables before reconciliation
      const catBefore = await getCatalogSnapshot(client);
      const dataBefore = await getAppDataSnapshot(client);
      assert.strictEqual(Object.keys(dataBefore).length, 12, "Scenario C: expected all 12 model tables in snapshot");
      for (const [tbl, rows] of Object.entries(dataBefore)) {
        assert.ok(rows.length > 0, `Scenario C: expected non-empty fixture rows in table "${tbl}"`);
      }

      // Official Prisma 7 hotfix workflow: record corrective migration as applied WITHOUT executing SQL
      const resolveApplied = runPrisma(
        ["migrate", "resolve", "--applied", "20261016000000_repair_schema"],
        dbUrl
      );
      if (resolveApplied.status !== 0) {
        throw new Error(
          `Scenario C: migrate resolve --applied failed:\n${sanitize(resolveApplied.stderr || resolveApplied.stdout)}`
        );
      }

      // Subsequent deploy MUST be a clean no-op
      const deployNoop = runPrisma(["migrate", "deploy"], dbUrl);
      if (deployNoop.status !== 0) {
        throw new Error(
          `Scenario C: subsequent migrate deploy failed:\n${sanitize(deployNoop.stderr || deployNoop.stdout)}`
        );
      }

      assertSchemaMatches(dbUrl, "prisma/schema.prisma", "Scenario C after reconciliation deploy");

      // Verify catalog, sequences, and all 12 tables' data are 100% unchanged
      const catAfter = await getCatalogSnapshot(client);
      const dataAfter = await getAppDataSnapshot(client);

      assert.deepStrictEqual(
        catAfter,
        catBefore,
        "Scenario C: Application catalog or sequences mutated during reconciliation no-op deploy!"
      );
      assert.deepStrictEqual(
        dataAfter,
        dataBefore,
        "Scenario C: Application data mutated during reconciliation no-op deploy!"
      );

      // Verify sequence and defaults still usable
      const nextUser = await client.query(
        `INSERT INTO "users" ("name", "email", "updatedAt") VALUES ('New User', 'new@example.com', $1) RETURNING "id", "emailVerified", "isWatchlistPublic"`,
        [now]
      );
      if (nextUser.rows[0].id !== 3 || nextUser.rows[0].emailVerified !== false || nextUser.rows[0].isWatchlistPublic !== true) {
        throw new Error("Scenario C: sequence or defaults not working after deploy");
      }
    } finally {
      await client.end();
    }

    console.log("✔ Scenario C passed");
  } finally {
    await dropDisposableDb(adminClient, dbName);
  }
}

// ============================================================================
// Scenario D: Narrow Data/Preparation Guards & Baseline Preflight Rejections
// ============================================================================
async function runScenarioD(adminClient: pg.Client): Promise<void> {
  console.log("\n--- Scenario D: Narrow Data Guards & Baseline Preflight Rejections ---");

  // D.1: Baseline preflight rejection check against scripts/legacy-schema.prisma
  {
    console.log("  Testing D.1: Read-only preflight detects unsupported legacy baseline drift (exit code 2)");
    const { dbName, dbUrl } = await createDisposableDb(adminClient, "s4_preflight");
    try {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query(MIGRATION_1_SQL);
        await client.query(MIGRATION_2_SQL);
        await client.query(MIGRATION_3_SQL);

        // Introduce unexpected baseline drift on legacy DB (e.g. alter name to TEXT)
        await client.query(`ALTER TABLE "users" ALTER COLUMN "name" TYPE TEXT`);

        // Read-only preflight check against scripts/legacy-schema.prisma MUST exit with code 2 (drift detected)
        const diffRes = runPrisma(
          ["migrate", "diff", "--from-config-datasource", "--to-schema", "scripts/legacy-schema.prisma", "--exit-code"],
          dbUrl
        );
        if (diffRes.status !== 2) {
          throw new Error(
            `Scenario D.1: preflight should have exited with code 2 (drift detected), but got ${diffRes.status}:\n${sanitize(diffRes.stderr || diffRes.stdout)}`
          );
        }
      } finally {
        await client.end();
      }
    } finally {
      await dropDisposableDb(adminClient, dbName);
    }
  }

  async function testGuardCase(
    subtag: string,
    description: string,
    setupMutation: (client: pg.Client) => Promise<void>,
    expectedErrorSubstring: string
  ): Promise<void> {
    console.log(`  Testing D.${subtag}: ${description}`);
    const { dbName, dbUrl } = await createDisposableDb(adminClient, `s4_${subtag}`);
    try {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query(MIGRATION_1_SQL);
        await client.query(MIGRATION_2_SQL);
        await client.query(MIGRATION_3_SQL);

        const r1 = runPrisma(["migrate", "resolve", "--applied", "20260519065127_init"], dbUrl);
        const r2 = runPrisma(["migrate", "resolve", "--applied", "20260519070248_init"], dbUrl);
        const r3 = runPrisma(["migrate", "resolve", "--applied", "20260519202115_init"], dbUrl);
        if (r1.status !== 0 || r2.status !== 0 || r3.status !== 0) {
          throw new Error("Failed to baseline legacy migrations in Scenario D test");
        }

        await setupMutation(client);

        const catBefore = await getCatalogSnapshot(client);
        const dataBefore = await getAppDataSnapshot(client);

        const deploy = runPrisma(["migrate", "deploy"], dbUrl);
        if (deploy.status === 0) {
          throw new Error(`Scenario D.${subtag}: deploy should have failed but succeeded!`);
        }

        const combinedErr = deploy.stderr + "\n" + deploy.stdout;
        if (!combinedErr.includes(expectedErrorSubstring)) {
          throw new Error(
            `Scenario D.${subtag}: error did not contain "${expectedErrorSubstring}":\n${sanitize(combinedErr)}`
          );
        }

        const catAfter = await getCatalogSnapshot(client);
        const dataAfter = await getAppDataSnapshot(client);

        assert.deepStrictEqual(
          catAfter,
          catBefore,
          `Scenario D.${subtag}: Application catalog mutated during rolled-back migration!`
        );
        assert.deepStrictEqual(
          dataAfter,
          dataBefore,
          `Scenario D.${subtag}: Application data mutated during rolled-back migration!`
        );
      } finally {
        await client.end();
      }
    } finally {
      await dropDisposableDb(adminClient, dbName);
    }
  }

  const fixedNow = new Date("2026-10-16T00:00:00.000Z");

  // D.2: Reject user with NULL name
  await testGuardCase(
    "null_name",
    "Reject user with NULL name",
    async (client) => {
      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "updatedAt") VALUES (1, NULL, 'test@example.com', $1)`,
        [fixedNow]
      );
    },
    "NULL name"
  );

  // D.3: Reject user with NULL email
  await testGuardCase(
    "null_email",
    "Reject user with NULL email",
    async (client) => {
      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "updatedAt") VALUES (1, 'Alice', NULL, $1)`,
        [fixedNow]
      );
    },
    "NULL email"
  );

  // D.4: Reject duplicate accounts
  await testGuardCase(
    "duplicate_acc",
    "Reject duplicate accounts violating modern unique constraint",
    async (client) => {
      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "updatedAt") VALUES (1, 'User 1', 'u1@test.com', $1), (2, 'User 2', 'u2@test.com', $1)`,
        [fixedNow]
      );
      await client.query(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "updatedAt") VALUES
         ('a1', 'dup-account-id', 'github', 1, $1),
         ('a2', 'dup-account-id', 'github', 2, $1)`,
        [fixedNow]
      );
    },
    "duplicate records exist"
  );

  // D.5: Reject duplicate mapped watchlist items
  await testGuardCase(
    "duplicate_watchlist",
    "Reject duplicate mapped watchlist items",
    async (client) => {
      await client.query(
        `INSERT INTO "users" ("id", "name", "email", "updatedAt") VALUES (1, 'User 1', 'u1@test.com', $1)`,
        [fixedNow]
      );
      await client.query(`INSERT INTO "titles" ("id", "title", "type") VALUES (1, 'T1', 'movie'), (2, 'T2', 'movie')`);
      await client.query(`CREATE TYPE "TmdbMediaType" AS ENUM ('movie', 'tv')`);
      await client.query(`ALTER TABLE "watchlist_items" ADD COLUMN "tmdbId" INTEGER, ADD COLUMN "mediaType" "TmdbMediaType"`);
      await client.query(
        `INSERT INTO "watchlist_items" ("id", "userId", "titleId", "tmdbId", "mediaType", "updatedAt") VALUES
         (1, 1, 1, 550, 'movie', $1),
         (2, 1, 2, 550, 'movie', $1)`,
        [fixedNow]
      );
    },
    "duplicate (userId, tmdbId, mediaType) rows detected"
  );

  // D.6: Reject preparation column with incompatible type
  await testGuardCase(
    "incompat_prep_col",
    "Reject prepared tmdbId column with incompatible type (TEXT)",
    async (client) => {
      await client.query(`ALTER TABLE "watchlist_items" ADD COLUMN "tmdbId" TEXT`);
    },
    "Incompatible column watchlist_items.tmdbId"
  );

  // D.7: Reject prepared enum with incompatible labels
  await testGuardCase(
    "incompat_enum_labels",
    "Reject prepared TmdbMediaType enum with incompatible labels",
    async (client) => {
      await client.query(`CREATE TYPE "TmdbMediaType" AS ENUM ('film', 'show')`);
    },
    "Incompatible enum labels"
  );

  console.log("✔ Scenario D passed");
}

// ----------------------------------------------------------------------------
// Main Execution Driver
// ----------------------------------------------------------------------------
async function main() {
  console.log("=== WatchWise Migration Reproducibility Verification ===");

  const adminClient = new Client({ connectionString: parsedAdminUrl.toString() });
  try {
    await adminClient.connect();
  } catch (err: unknown) {
    console.error(`Failed to connect to admin database at ${parsedAdminUrl.hostname}:${parsedAdminUrl.port || "5432"}: ${formatError(err)}`);
    process.exit(1);
  }

  const cleanupErrors: Error[] = [];

  const cleanupAll = async () => {
    for (const dbName of Array.from(createdDatabases)) {
      try {
        await adminClient.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName]
        );
        await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
        createdDatabases.delete(dbName);
      } catch (err: unknown) {
        cleanupErrors.push(new Error(`Failed to clean up database ${dbName}: ${formatError(err)}`));
      }
    }
  };

  process.on("SIGINT", async () => {
    await cleanupAll();
    process.exit(1);
  });
  process.on("SIGTERM", async () => {
    await cleanupAll();
    process.exit(1);
  });

  try {
    await runScenarioA(adminClient);
    await runScenarioB(adminClient);
    await runScenarioC(adminClient);
    await runScenarioD(adminClient);
  } finally {
    try {
      await cleanupAll();
    } finally {
      await adminClient.end();
    }
  }

  if (cleanupErrors.length > 0) {
    console.error("Cleanup failures detected:");
    for (const e of cleanupErrors) {
      console.error(" - " + e.message);
    }
    process.exit(1);
  }

  console.log("\n=======================================================");
  console.log("ALL 4 MIGRATION FIXTURE SCENARIOS PASSED SUCCESSFULLY!");
  console.log("=======================================================");
}

main().catch((err: unknown) => {
  console.error("Migration verification failed:", formatError(err));
  process.exit(1);
});
