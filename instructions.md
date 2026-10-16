# Backend development criteria

These are requirements for future work, not claims that all current code meets
them. Read [README.md](README.md) for setup/baseline and [AGENTS.md](AGENTS.md)
for implementation and review responsibilities.

## Task preparation

Define the user problem, affected procedures/frontend consumers, exclusions,
schema/environment changes, acceptance scenarios, actual verification commands,
and baseline failures. Inspect existing flows/migrations before implementation.
Keep changes small and reviewable; preserve the stack unless the task calls for more.

## Required criteria

| Area | Acceptance criterion |
| --- | --- |
| Contracts | Procedure names, inputs, output nullability, serialization, and errors agree with frontend consumers; coordinate breaking changes across both repositories. |
| Authentication | Protected actions reject anonymous callers and derive identity from sessions, never a client-supplied acting user ID. |
| Ownership | Other users cannot edit/delete someone else's resources; test owner, other-user, and anonymous cases. |
| Privacy | Private activity/watchlists stay private through profiles, feeds, and alternate paths; test settings transitions. |
| Validation | Validate IDs, enums, cursors/pagination, lengths, and numeric bounds before database/provider calls; invalid inputs return deliberate errors. |
| Identity | Preserve the `(tmdbId, mediaType)` pair (`movie`/`tv`); internal title IDs and display `series` values are distinct. |
| Persistence | Preserve unique constraints, use transactions where related writes require atomicity, and make retry behavior explicit. |
| Migrations | Include reviewed SQL and client generation; prove fresh bootstrap and development-database upgrade without unplanned data loss. |
| Services | Mock TMDB/Groq success, failure, and malformed responses; new calls need bounded timeout/retry behavior and validated AI JSON. |
| Performance | Bound new lists/concurrency and use stable pagination; measure repeated detail calls before optimizing. |
| Abuse/errors | Protect costly/write endpoints appropriately; avoid secrets or personal data in logs/errors. Process-local rate limiting is not shared across instances. |
| Deployment shape | Importing `app.ts` or the API handler does not open a listener; preserve auth/tRPC paths and serverless routing. |

## Verification

After `npm ci`, run:

```powershell
npm run build
npm test
npm run test:migrations
npm exec -- prisma validate
npm run contract:check
```

There is no lint script. Build emits ignored `dist/`; `npm start` still runs
`tsx server.ts`. Prisma validation does not connect to PostgreSQL or prove
migration completeness. `npm run contract:check` verifies that the checked-in
frontend declaration snapshot (`app-router.d.ts`) matches the backend compiler
closure without drift. The four existing tests cover an AI model request,
app exports/root response, and Vercel rewrite configuration. They do not prove
database, auth, privacy, or all-procedure correctness.

For behavior changes, add focused regression tests with relevant auth, ownership,
and privacy cases. Mock external providers; use an isolated database for database
tests. For API/auth/schema changes also check frontend build/lint/Vitest and
smoke-test the affected browser flow with development accounts. Record missing
credentials/infrastructure as blocked, not passed. Relevant gates must pass;
pre-existing failures need baseline evidence and proof of no new failures. Never
weaken checks to hide errors. Documentation-only edits need link/path/command
review and `git diff --check`, not new runtime tests.

## Database rules

1. Treat `prisma/schema.prisma` as the intended model; inspect the actual database
   and migration history before changing data.
2. Do not edit historical migrations applied to shared databases. Use reviewed
   corrective migrations and a safe upgrade/rollback strategy.
3. Generate with `npm exec -- prisma generate`, then inspect the diff. Generated
   artifacts are tracked; do not hand-edit them or mix generations. Generation
   is not migration.
4. Check the intended development database before any migration command. Never
   reset or add `db push --accept-data-loss` automatically. Production migrations,
   destructive changes, and live backfills require explicit user authorization.
5. Prove the full migration chain on an empty disposable database and require
   zero Prisma schema diff. Preflight historical baselines; the corrective
   migration rejects unsafe legacy data/preparation atomically. Already-current
   databases reconcile history after equivalence checks, without rerunning DDL. Supply the
   separate loopback QA admin URL before running the migration gate.

## Starting backlog

1. [Repository repair implemented 2026-10-16] The appended migration reproduces
   current auth/profile/social/TMDB schema. Preserve fresh/legacy/reconciliation
   verification. Live production history reconciliation remains a separate
   authorized operation, with equivalence/history/checksum proof first.
2. Fix `src/routers/activity.router.ts`'s following feed: unlike `userActivity`,
   it lacks the `isActivityPublic` filter. Add privacy regression tests first.
3. Cover context/session behavior, ownership/privacy, mutations, and provider
   errors; add CI in a separate implementation task. No workflow exists today.
4. [Implemented 2026-10-15] Distribute the generated AppRouter declaration with
   frontend source. Keep backend generation/drift checks and frontend
   `typecheck:contract` in the review gates; ordinary frontend builds are independent.
5. Review the in-memory limiter and protection of costly AI operations; assess
   timeouts, retries, AI JSON validation, pagination, and upstream detail calls.
   Use measured evidence for performance work, not invented targets.

## Definition of done

Every code/configuration/user-visible changeset includes a `README.md` update
and a relevant workflow update in `AGENTS.md` or this file. If workflow semantics
are unchanged, still add a verification/change record to the workflow document.
Record
the current checks separately from historical baseline results.

Report resulting behavior, affected procedures/files, frontend compatibility,
actual commands/results, integration scenarios, migration/rollback notes, review
verdict, and limitations. Update docs for new variables/commands. Coding changes
require independent GPT-6.1 Sol (`gpt-6.1-sol`) `APPROVED` review before Codex
lands them; approval does not authorize pushing or deployment.

## Workflow verification record: 2026-10-15

Local configuration uses development auth URLs/cookies and the user-selected
shared Neon database. Both env files remain ignored; no migrations, backfills,
or test writes were performed. The read-only connectivity probe does not prove
database/schema readiness.

Backend build, four tests, Prisma validation, and contract drift checks passed
independent Codex verification and GPT-6.1 Sol tooling review. An altered temporary
contract was rejected without modifying targets; source hashing was verified
across LF/CRLF inputs. Backend runtime behavior/schema stayed unchanged; the
runtime source edit exports an existing type. Migration history and following-feed
privacy remain open. Every subsequent changeset still requires README plus a
workflow verification/change record.

On 2026-10-16, independent GPT-6.1 Sol whole-diff review returned **APPROVED**,
carrying the verified unchanged backend tooling forward and approving the paired
frontend changes and documentation. No push, deployment, or database changes
were performed as part of that approval.

## Migration workflow update: 2026-10-16

`npm run test:migrations` is a separate integration gate requiring explicit
`MIGRATION_TEST_ADMIN_URL` for owned disposable loopback databases. Unit tests
remain service-free. Check full bootstrap, redeployment, guarded legacy rollback,
authoritative mapping/retry, modern history reconciliation/data preservation and
invalid data/preparation rejection. Preflight unsupported historical schema drift
against the verified comparison snapshot. Compare application data/catalog/sequence snapshots and verify all
disposable databases are removed. Do not infer TMDB identity from internal IDs
or alter historical migrations. Runtime shared Neon remains read-only; fixture
results do not authorize production deploy/backfill. README records actual gate
results separately from the historical cleanup approval.

Codex verified all four fixture groups on PostgreSQL 18.4 on 2026-10-16:
fresh bootstrap/redeployment, populated legacy rollback/preparation/upgrade,
already-current history reconciliation, and preflight/invalid data/preparation
rejections. Original columns/rows and sequences survive successful legacy upgrade;
all 12 modern tables have fixture records and remain unchanged after history
reconciliation. Build, four unit tests, schema validation and contract checks
also pass. Production Neon was not changed; keep that limitation explicit.
