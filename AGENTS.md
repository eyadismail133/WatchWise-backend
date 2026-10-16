# WatchWise backend agent instructions

Read [README.md](README.md) for setup and [instructions.md](instructions.md) for
acceptance criteria. Run Git/npm commands in this repository. In the paired local
workspace, also read the parent `AGENTS.md`. Current user instructions take
precedence over repository defaults.

## Coding workflow

1. Codex investigates requirements, architecture, existing changes, and actual
   verification commands; write a bounded implementation brief.
2. Antigravity implements through the installed `agy-delegate` skill and global
   `implement` lane. Read the skill first; use its configured default model unless
   the user chooses another. Include scope, files, context, API/schema effects,
   acceptance criteria, commands, baseline failures, and no-commit instructions.
3. GPT-6.1 Sol (`gpt-6.1-sol`) reviews the actual diff and independently verifies
   relevant gates. A GPT-6.1 Sol orchestrator may review directly; otherwise use
   a GPT-6.1 Sol review subagent or the `codex-delegate` relay with that explicit
   model and `--lane review --read-only`. Use only this model for review.
   Reviewers only report: no edits, delegation, or commits.
4. Require `APPROVED` or `CHANGES_REQUESTED` with evidence. Return findings to the
   same Antigravity conversation using its recorded ID; use `--resume-last` only
   when unambiguous. Repeat until criteria and relevant gates pass. An
   implementer's self-report is not approval.
5. Only Codex lands approved changes within user scope. Review approval does not
   authorize pushing, publishing, or deploying.

Setup, investigation, and documentation-only work do not require implementation
dispatch. If Antigravity is unavailable, unauthenticated, or permission-blocked,
diagnose and report the blocker; do not bypass permissions or silently substitute
another implementer. On this machine the fleet config is
`C:/Users/dell/.config/delegate-skills/config.json`, and the skill is
`C:/Users/dell/.codex/skills/agy-delegate/SKILL.md`. If PATH is stale, prepend
`C:/Users/dell/AppData/Local/agy/bin` to the child PATH, preserving other entries.
Workspace file permissions and shell command permissions are separate.

## Architecture boundaries

- `server.ts`: dotenv and local listener. `app.ts`: Express composition/default
  export. `api/[...path].ts`: serverless export; keep imports free of listeners.
- `src/router.ts`: `AppRouter` contract; `src/routers/`: feature procedures.
- `src/context.ts`, `src/trpc.ts`: identity, SuperJSON, auth/rate middleware.
- `lib/auth.ts`: Better Auth, trusted origins, cookies.
- `lib/prisma.ts`: adapter/client; `lib/openai.ts`: Groq-compatible SDK client.
- `services/`: TMDB and AI; `src/services/activity.ts`: activity recording.
- `prisma/schema.prisma`, `prisma/migrations/`: model and migration history.
- `generated/prisma/`: generated artifacts; never hand-edit them.

## Required guardrails

- Start with `git status --short --branch`; preserve unrelated changes.
- Preserve `/api/auth`, `/api/trpc`, credentialed CORS, SuperJSON, and existing
  procedures unless contract changes are explicitly in scope.
- Validate inputs with Zod; derive acting user IDs from session context. Enforce
  ownership/privacy in all relevant procedures, including following feeds.
- TMDB identity is `(tmdbId, mediaType)` with `movie`/`tv`; internal `Title.id`
  and display `TitleType.series` are distinct.
- Use `.js` extensions in runtime relative imports under NodeNext. No shared type
  package exists; do not couple frontend and backend through sibling imports.
- Never commit `.env`, credentials, dependency/build folders, or user data.
- Schema changes need reviewed migrations and client generation. Preserve the
  appended repair and verified historical preflight workflow; never silently
  reset a database, use production for tests, or run backfills as routine validation.
- Gates: `npm run build`, `npm test`, `npm exec -- prisma validate`, `npm run contract:check`.
  There is no lint script. Schema validation does not check migration drift.
- Contract synchronization: `scripts/generate-contract.ts` generates a standalone
  declaration snapshot (`app-router.d.ts`) using the TypeScript compiler API closure rooted
  at `src/router.ts`. Run `npm run contract:generate` to regenerate and `npm run contract:check`
  to verify zero drift. The generator executes no runtime server listeners, touches no `.env`,
  and makes no database or provider calls. Inputs are normalized to LF before hashing.
- Mock provider calls; add relevant auth/ownership/privacy tests. Report blocked
  database integration separately from successful unit/build checks.
- Do not treat the process-local limiter as distributed protection. New queries
  need bounds; upstream calls need deliberate failure handling and AI output
  needs validation. Avoid blanket suppressions or unexplained `any`.
- Every code/configuration/user-visible changeset must update `README.md` and
  the relevant workflow in `AGENTS.md` or `instructions.md` in the same change.
  If workflow semantics need no change, still add a verification/change record
  to the relevant workflow document. Document actual checks and limitations.
- Treat the local `.env` connection as shared production data if it points to
  the supplied Neon database. Localhost URLs and development cookies do not
  isolate that database. No migrations, backfills, or test writes there.

## Migration delivery workflow: 2026-10-16

Migration changes require `npm run test:migrations` with an explicit disposable
loopback `MIGRATION_TEST_ADMIN_URL`, in addition to build, unit, Prisma validation
and contract gates. Do not use runtime `DATABASE_URL` as the verifier fallback.
Preserve historical SQL, assert fresh-chain schema equality, safe legacy
rejection/upgrade with authoritative TMDB mappings, and unchanged modern data.
Preflight historical targets against the verified legacy comparison schema;
unsupported drift requires separate review. Already-current targets reconcile
history after proving equivalence; they do not execute the corrective DDL again.
Only narrow verified mapping-preparation objects may use guarded `IF NOT EXISTS`.
A Prisma failed-migration metadata resolve is allowed only in
owned QA databases or a separately authorized operator recovery after proving
transaction rollback. An already-current production history reconciliation also
requires separate authorization. Production execution remains outside routine validation.

Codex delivery verification on 2026-10-16 passed build, four unit tests, Prisma
validation, contract drift and all four migration fixture groups on disposable
PostgreSQL 18.4. Complete original-row/sequence preservation and modern
reconciliation were checked alongside guarded rollback and explicit preflight
drift rejection. Original SQL, current model and generated client stayed unchanged.
README records exact scenarios and production limitations.
