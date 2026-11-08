# PhysioTrace infrastructure migration status

Target: Auth0 + TigerData PostgreSQL + Vultr Cloud Compute / Object Storage.

This archive contains the first migration implementation pass, not a completed
production migration. The original UI and feature code are retained.

## Implemented in this pass

- Added Auth0 Next.js SDK v4 configuration and middleware integration.
- Replaced the visible password form with Auth0 Universal Login entry points.
- Updated the PhysioTrace client to obtain an Auth0 access token from a
  same-origin server route before calling FastAPI.
- Added FastAPI Auth0 JWT validation using the tenant JWKS, issuer and API
  audience.
- Added an Auth0-subject-to-stable-UUID identity mapping bootstrap migration.
  Existing PhysioTrace SQL tables use UUID foreign keys, while Auth0 `sub`
  values are opaque strings.
- Added an asyncpg TigerData connection pool and database health probe.
- Added Vultr Cloud Compute cloud-init, Docker Compose and Caddy reverse-proxy
  deployment templates.
- Added an Auth0 Post-Login Action template for namespaced email, verification,
  and display-name claims used by the API identity mapper.

## Not yet migrated — do not deploy as a completed cutover

The remaining legacy paths are still active in the codebase and must be ported
before Supabase can be disconnected:

1. `backend/app/routers/physio.py` and `backend/app/routers/exercises.py` still
   use Supabase PostgREST RPC/table endpoints for care data and exercise demos.
2. `backend/app/routers/ai.py` still increments daily usage through a Supabase
   RPC.
3. `frontend/src/features/notes/notes.tsx` and
   `frontend/src/features/uploads/uploads.tsx` still use Supabase Realtime,
   database and Storage clients.
4. `ml/worker.py` still claims and completes training jobs through Supabase RPC.
5. Existing `backend/supabase/migrations/` contain Supabase-specific RLS and
   Storage assumptions. The new `backend/migrations/0001_auth0_identity_bootstrap.sql`
   is a compatibility foundation, not a complete conversion of those migrations.
6. Vultr Object Storage credentials are documented, but upload, delete and
   signed-URL code has not yet been switched from Supabase Storage to S3.
7. The frontend lockfile has not been regenerated in this environment. Run
   `npm install` in `frontend/` before using `npm ci` in a reproducible build.

## Required next engineering pass

- Convert every `Care.call()` REST/RPC operation into parameterized asyncpg SQL
  queries and transactions. Set the per-request mapped UUID in
  `request.jwt.claim.sub` and use a non-owner runtime database role with RLS.
- Port every Supabase RPC to a reviewed SQL function or an explicit service
  method. Never expose a database owner or bypass-RLS credential to the API.
- Convert storage paths to S3-compatible Vultr Object Storage with private
  buckets and short-lived presigned URLs.
- Convert notes and file listing/upload UI to authenticated FastAPI endpoints;
  replace Realtime with polling or a separately designed event transport.
- Port the offline exercise trainer to direct PostgreSQL transactions and
  row-level job claiming (`FOR UPDATE SKIP LOCKED`).
- Finish SQL migration and test it against a TigerData project, including RLS,
  patient/therapist isolation, consent revocation, admin grants, and idempotent
  rep submission.
- Add Auth0 Post-Login Action namespaced claims if email/name are needed in the
  access token, and configure Auth0 API audience, callback and logout URLs.
- Regenerate package locks and run frontend build/tests and backend pytest.

## Migration order

1. Create TigerData PostgreSQL and a restricted runtime role.
2. Apply `backend/migrations/0001_auth0_identity_bootstrap.sql` as the database
   owner, then apply the converted application schema migrations.
3. Create an Auth0 Regular Web Application and a custom API. Set the API
   signing algorithm to RS256 and use its Identifier as `AUTH0_AUDIENCE`.
4. Configure Auth0 Allowed Callback URL as `https://YOUR_DOMAIN/auth/callback`,
   Allowed Logout URL as `https://YOUR_DOMAIN`, and Allowed Web Origin as
   `https://YOUR_DOMAIN` (plus localhost for development).
5. Provision Vultr Cloud Compute (Ubuntu 24.04), apply `infra/vultr/cloud-init.yaml`,
   clone this repository, create the root `.env`, and deploy with
   `docker compose -f infra/vultr/compose.yaml up -d --build`.
6. Do not remove the original Supabase project until the remaining legacy
   paths above have been ported, data has been migrated, and end-to-end tests
   pass.
