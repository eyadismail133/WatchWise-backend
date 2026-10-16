# WatchWise backend

Express/tRPC API for movie/TV discovery, watchlists, favorites, AI recommendations,
taste profiles, social profiles, follows, comments, and feeds.

- Repository: [eyadismail133/WatchWise-backend](https://github.com/eyadismail133/WatchWise-backend).
- Client: [eyadismail133/WatchWise-frontend](https://github.com/eyadismail133/WatchWise-frontend).
- Contributor rules: [AGENTS.md](AGENTS.md), [instructions.md](instructions.md).

## Stack and layout

TypeScript, Express 5, tRPC 11/SuperJSON, Prisma 7 with PostgreSQL adapter, Better
Auth, Zod, Axios/TMDB, and the OpenAI SDK configured for Groq.

| Path | Responsibility |
| --- | --- |
| `server.ts` | Load environment and listen on `PORT` (default 3000) |
| `app.ts`, `api/[...path].ts` | Express composition and serverless exports |
| `src/router.ts`, `src/routers/` | `AppRouter` and feature procedures |
| `src/context.ts`, `src/trpc.ts` | Sessions, serialization, protection/rate middleware |
| `lib/` | Auth, Prisma adapter, Groq-compatible SDK client |
| `services/`, `src/services/activity.ts` | TMDB/AI and activity recording |
| `prisma/`, `generated/prisma/` | Schema/migrations and generated artifacts |
| `test/` | Node test suites executed with `tsx` |
| `scripts/backfill-usernames.ts` | Database-writing maintenance script; not startup or routine validation |
| `scripts/generate-contract.ts` | Dev-only tool generating reproducible frontend declaration snapshot (`app-router.d.ts`) from compiler closure |

## Local setup

Use Node.js 24.x for this workspace (checked on 24.16.0 with npm 11.13.0).
The repository does not pin a runtime version. Use the committed npm lockfile.

```powershell
git clone https://github.com/eyadismail133/WatchWise-backend.git
cd WatchWise-backend
npm ci
```

Copy the tracked template to an untracked `.env`, then use development values:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing local `.env`. Its values are never committed.

```dotenv
DATABASE_URL=postgresql://watchwise:local-password@localhost:5432/watchwise_dev
BETTER_AUTH_SECRET=replace-with-a-long-random-development-secret
BETTER_AUTH_URL=http://localhost:3000
TRUSTED_ORIGINS=http://localhost:5173,http://localhost:4173
TMDB_API_KEY=replace-with-your-tmdb-api-key
GROQ_API_KEY=replace-with-your-groq-api-key
PORT=3000
NODE_ENV=development
```

These are placeholders, not working credentials. Generate a local auth secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection for runtime and Prisma CLI |
| `BETTER_AUTH_SECRET` | Private authentication signing secret |
| `BETTER_AUTH_URL` | Backend origin; production startup rejects a missing value |
| `TRUSTED_ORIGINS` | Comma-separated frontend origins for CORS/auth; defaults to `http://localhost:5173` when absent |
| `TMDB_API_KEY` | Server-side TMDB v3 API key |
| `GROQ_API_KEY` | Private Groq key; missing key can prevent app imports/startup |
| `PORT` | Local listener port; defaults to 3000 |
| `NODE_ENV` | `production` enables secure, cross-site session-cookie attributes |

### Local configuration added on 2026-10-15

The ignored `.env` in this workspace uses localhost backend/auth URLs,
`NODE_ENV=development`, frontend/preview trusted origins, supplied provider keys,
and a newly generated development-only auth secret. It contains no frontend Vite
settings. The supplied `TMDB_API_ACCESS_TOKEN` is retained locally, but current
`services/tmdb.ts` authenticates with `TMDB_API_KEY`.

The configured database remains the supplied remote Neon production/shared
database. Running the app locally does not isolate its data; normal signed-in
mutations would affect that database. No migration, backfill, or test write is
permitted against this connection. Replace `DATABASE_URL` with an isolated
development connection before testing writes. Migration verification uses a
separate disposable PostgreSQL cluster on loopback, with fixture data only.
It does not use the installed service or change this runtime connection.
Cloudinary settings belong only in the frontend.

### Database setup and migration repair

The three original migrations are immutable. The appended
`20261016000000_repair_schema` migration supplies the missing auth/profile,
privacy, social/favorite/activity, and TMDB watchlist schema. It runs in one
atomic PostgreSQL operation for a verified historical baseline. It rejects
missing required identities/mappings rather than guessing data. Review the SQL
and verify the target connection before applying it. Unsupported drift requires
separate investigation; ordinary deployment does not detect every untouched
column, default, or constraint difference.

For a newly created, empty, isolated development database:

```powershell
# Set DATABASE_URL to your isolated development database first.
npm exec -- prisma validate
npm exec -- prisma migrate deploy
npm exec -- prisma generate
```

Generation does not create tables. Generated artifacts are tracked; inspect the
diff afterward. `db push`, resets, and `--accept-data-loss` are not the bootstrap
workflow. Nothing runs a migration automatically at app startup.

For an existing historical database, inspect schema and `_prisma_migrations`
first. Replay the original three migrations on an isolated database and compare
their result with the checked-in `scripts/legacy-schema.prisma` snapshot. Before
preparing or upgrading the target, run this read-only preflight:

```powershell
npm exec -- prisma migrate diff --from-config-datasource --to-schema scripts/legacy-schema.prisma --exit-code
```

Exit 0 means no Prisma schema difference; exit 2 means drift to investigate and
exit 1 means an error. Also inspect objects Prisma does not represent, completed
migration history/checksums, and data constraints; use a maintenance window and
backup. Do not run this historical upgrade against a database already matching
the current model. Legacy users need non-NULL names/emails and valid unique identities. Legacy
watchlist rows need verified `(tmdbId, mediaType)` mappings. Internal `titleId`
values are not TMDB IDs. Missing mappings or incompatible shape cause an atomic
failure; no placeholder emails or inferred IDs are used. Only the documented
nullable mapping preparation is supported on top of the historical baseline.

To prepare a supported legacy database, an authorized operator applies
`scripts/prepare-legacy-watchlist.sql`, then fills its nullable mapping columns
using independently verified IDs and `movie`/`tv` values for each watchlist row.
This preparation is separate so verified mappings survive a failed corrective
transaction. Check that no mapping remains NULL before retrying. Preserve the
original title relation and all existing IDs, timestamps, statuses and notes.

If a deploy failed, verify the SQL transaction rolled back and inspect the
database before resolving Prisma's failed-migration metadata. Only after proving
rollback and correcting the reported condition:

```powershell
npm exec -- prisma migrate resolve --rolled-back 20261016000000_repair_schema
npm exec -- prisma migrate deploy
```

Do not mark missing schema changes as applied to skip them, edit original
migration SQL, or rerun blindly after a connection failure. There is no automatic
down migration: after successful deployment, recovery requires a reviewed forward
fix or an authorized backup restore. Production execution/backfill is a separate
operation; the supplied Neon database has not been migrated by this work.

### Already-current database: reconcile history separately

The read-only investigation found the supplied Neon schema already matches
`prisma/schema.prisma`, while its history contains only the original three
completed migrations. Do **not** run the corrective DDL against it. Follow
[Prisma's history reconciliation workflow](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing)
for changes that already exist in a database.

An authorized operator must first prove that the reviewed four-migration chain
replays to the same final schema, compare the target against that proven schema,
inspect migration-specific objects/data invariants, and verify all original
checksums with no unexplained failed/unknown migration records. Record the
reviewed repository revision and corrective SQL checksum. Only after those
checks, and separate production authorization, mark this exact existing change
as applied:

```powershell
npm exec -- prisma migrate resolve --applied 20261016000000_repair_schema
```

This writes migration metadata without executing the corrective SQL. Verify
history and zero schema diff afterward before ordinary deployments. It is not a
substitute for creating missing tables or backfilling legacy rows. The isolated
current-schema fixture tests this reconciliation path; no reconciliation or
other production write was performed against Neon here.

### Reproduce migration checks locally

`npm run test:migrations` requires an explicit `MIGRATION_TEST_ADMIN_URL` for a
disposable PostgreSQL cluster on loopback, whose role can create/drop databases:

```powershell
$env:MIGRATION_TEST_ADMIN_URL="postgresql://watchwise_qa@127.0.0.1:5432/postgres"
npm run test:migrations
```

Use your own local port and credentials. The verifier creates uniquely named
owned fixture databases and removes only those it created. It never falls back
to runtime `DATABASE_URL`. It exercises full bootstrap and repeated deployment,
legacy rollback/preparation/upgrade, already-current history reconciliation and
data preservation, and invalid data/preparation rejection. Historical schema
drift is checked by preflight, not a general-purpose SQL repair engine. It is separate from the service-free unit
suite. A successful schema validation or build alone does not prove migrations.

After configuring database and provider keys:

```powershell
npm run dev
```

Start the frontend separately on `http://localhost:5173`. Its Vite `/api` proxy
targets this service; keep frontend API URL variables unset for local development.
Use `localhost` consistently and update trusted origins if changing ports.

## Endpoints and contract

- `GET /`: `Server is Live!`; liveness only, not database/provider readiness.
- `/api/auth/*`: Better Auth email/password sessions.
- `/api/trpc`: tRPC batch endpoint with SuperJSON; `AppRouter` is exported from
  `src/router.ts`.

Frontend requests include cookies. Preserve auth/cookie/origin alignment. API TMDB
references use `tmdbId` and `mediaType: "movie" | "tv"`; internal title IDs and
display `series` are distinct. No shared frontend/backend type package exists.
The frontend instead checks in a generated declaration snapshot; ordinary
frontend installation/build does not require a sibling checkout.

After changing procedures or inferred types, run `npm run contract:generate`
then `npm run contract:check`. Their default target is sibling
`WatchWise-frontend/src/contracts/app-router.d.ts`; append
`-- --out "C:/path/to/frontend/src/contracts/app-router.d.ts"` for another layout.
Include the frontend declaration with its corresponding consumer change, then
run frontend build, lint, Vitest, and `npm run typecheck:contract`. Check mode is
read-only. Do not manually edit the snapshot. The generator hashes the compiler
source/type closure plus config, lockfile, schema, and itself, normalized to LF;
it starts no API listener and makes no database/provider requests.

## Commands and deployment shape

| Command | Effect |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run dev` | Nodemon with `tsx server.ts` |
| `npm start` | Run `tsx server.ts`, not the compiled bundle |
| `npm run build` | Run `tsc`, emitting ignored `dist/` |
| `npm test` | Run `tsx --test test/**/*.test.ts` |
| `npm run test:migrations` | Verify migrations against owned disposable loopback databases; explicit QA admin URL required |
| `npm exec -- prisma validate` | Validate schema/config, not migration completeness or connectivity |
| `npm exec -- prisma generate` | Regenerate client; may change tracked artifacts |
| `npm run contract:generate` | Generate frontend `app-router.d.ts` declaration snapshot from `AppRouter` closure |
| `npm run contract:check` | Verify frontend contract declaration matches backend source without drift |

There is no backend lint script. `npm start` requires runtime `tsx` even after
building. `api/[...path].ts` exports the app without opening a listener; Vercel
rewrites nested `/api/*` paths to that handler. Local root/rewrite tests do not
prove deployed behavior.

Production needs its backend `BETTER_AUTH_URL`, explicit frontend trusted origins,
and `NODE_ENV=production`; session cookies are HTTP-only, secure, and
`sameSite=none`. Verify browser cookie behavior on intended domains. Deployment,
production migrations, and backfills are separate authorized actions.

## Assessment baseline: 2026-10-15

Source: `main` at `ed81891`, before these documentation changes.

| Check | Observed result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Pass; vulnerability audit not run |
| `npm run build` | Pass |
| `npm test` | Pass: four tests; Better Auth warns about missing test-environment base URL |
| `npm exec -- prisma validate` | Pass; database connectivity/migrations not checked |

Known source limitations: incomplete migrations; `activity.feed` lacks the
`isActivityPublic` filter used by `userActivity`; a process-local limiter covers
selected procedures; tests are narrow regressions, not database/auth/privacy
integration coverage. No GitHub Actions workflow is checked in.

At this initial assessment, live PostgreSQL/provider flows had not been tested
and no application fixes had been made. Later local checks are recorded below;
production deployment, Groq, and Cloudinary integration remain unverified.
See [instructions.md](instructions.md) for criteria and improvement order.

## Change workflow

Every code, configuration, or user-visible update includes a README update and a
relevant `AGENTS.md`/`instructions.md` workflow update in the same changeset. If
workflow semantics are unchanged, add a verification/change record to the workflow
document anyway. Include
actual validation results and limitations, and obtain GPT-6.1 Sol approval for
code changes. Keep historical checks above distinct from current verification.

## Local setup verification: 2026-10-15

- `npm run build`, `npm test` (four passing tests), and
  `npm exec -- prisma validate` pass with the new local configuration.
- `src/routers/comment.router.ts`: exported `CommentRow` to unblock compiler declaration emit.
  No backend runtime or database/schema changes were made.
- `scripts/generate-contract.ts`: added dev-only contract generator using the TypeScript
  compiler API closure rooted at `src/router.ts`. Normalizes line endings to LF before hashing
  and preserves baseline commit `ed81891c5cfd59afa852bad930fdb9c3b8d14e4b`.
- `npm run contract:generate` emits the standalone `app-router.d.ts` snapshot.
- `npm run contract:check` passed with exit code 0 (zero drift). Tested drift detection on a
  temporarily altered target file; check mode rejected the drift with exit code 1 without
  modifying the target.
- Local backend liveness and proxied anonymous-session requests return HTTP 200;
  the anonymous session is `null`. Proxied TMDB trending returns HTTP 200.
- A read-only `SELECT 1` succeeds on the supplied Neon connection. This proves
  connectivity only, not schema completeness or migration correctness.
- `.env` and `.env.*` are ignored; the placeholder-only `.env.example` is tracked
  by policy. No database migration, backfill, or test write was executed.
- Groq calls and signed-in mutations were not exercised. The local frontend
  homepage renders provider-backed catalog data without browser console errors.
- Independent GPT-6.1 Sol review approved the backend tooling subset after build,
  four tests, Prisma validation, zero-drift/altered-target checks, and independent
  reconstruction of the 23-input source hash under LF and CRLF line endings.
  This does not establish migration or live authenticated-flow correctness.
- Final GPT-6.1 Sol whole-diff review returned **APPROVED** on 2026-10-16,
  carrying this verified tooling subset forward and approving the paired
  frontend fixes, tests, and documentation. At that earlier cleanup approval the
  changes remained local and uncommitted.

## Migration delivery verification: 2026-10-16

Codex independently verified the appended migration and checker against an owned
PostgreSQL **18.4** cluster on loopback, using fixture data only. The complete
`npm run test:migrations` gate passed with exit 0 and removed its owned databases:

| Fixture group | Verified result |
| --- | --- |
| A: Fresh database | All four migrations apply; zero current-model diff; second deploy is a no-op; defaults and sequences work |
| B: Populated historical database | Original-three replay matches the legacy snapshot; missing mappings fail atomically; preparation and authoritative mappings permit retry; zero final diff; every original column/row and sequence preserved before intentional FK/insert checks |
| C: Already-current database | All 12 application tables contain fixture rows; equivalence checked; history resolve plus deploy changes no application data, catalog or sequence state |
| D: Failure/preflight cases | Drift requires diff exit 2; six NULL/duplicate/invalid preparation cases reject and preserve prior application state |

The checker rejects missing/non-loopback admin connections and query/fragment
overrides before connecting. Snapshot comparisons include column definitions,
indexes/constraints, enum labels, sequence parameters/ownership/state and table
rows, excluding expected Prisma history bookkeeping. They verify these fixture
paths, not arbitrary database repair or every possible production custom object.

Backend build, four service-free tests, Prisma validation and the paired frontend
contract check pass. The three historical migration files, current schema and
generated client have no changes. Contract generation was synchronized after the
development dependency metadata update; no API runtime behavior changed here.

Delivery branch: `chore/local-development-setup`. README and workflow documents
are updated with this changeset. The supplied Neon database received no migration,
metadata reconciliation, backfill or test write. Its future history reconciliation
still requires the operator checks and separate production authorization above.
Following-feed privacy, broader auth/provider testing and CI remain separate work.
Independent GPT-6.1 Sol code/test review returned **APPROVED** after rerunning
all backend gates, including the four migration fixture groups, and confirming
that no owned fixture databases remained.
