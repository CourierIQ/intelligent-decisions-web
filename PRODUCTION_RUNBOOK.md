# IDI Web Production Runbook

Last audited: 2026-09-12

This is the operating procedure for `intelligent-decisions-web`, which serves
the IDI homepage, flagship ADBridge marketing page, CourierIQ beta intake,
Chargeback Studio, Revenue Leak Finder, BidLens, and ScopeFence.

It does not authorize a deployment, database write, restore, credential
rotation, or paid test environment. Each state-changing production step needs
the release owner's approval at execution time.

## Release boundary and owners

Assign a person to each role in the release record before starting. One person
may hold more than one role.

| Role | Responsibility |
| --- | --- |
| Release owner | Approves the candidate, deployment, rollback, and final go/no-go decision |
| Cloudflare owner | Worker configuration, secrets, routes, DNS, deployments, logs, and rollback |
| Database/Auth owner | Supabase migrations, RLS, Auth, backups, restore readiness, and post-release advisors |
| Payments owner | Stripe keys, webhook destination/events, tax configuration, entitlement reconciliation, and refunds |
| Email owner | Resend key, sending domains, delivery failures, and CourierIQ/Chargeback Studio email paths |
| AI owner | OpenAI project key, model access, usage limits, output quality, latency, and cost controls |
| Product owner | Manual acceptance for ADBridge, CourierIQ, and each MVP journey |

The Worker, static assets, and product API handlers are one deployable unit.
Supabase schema changes are a separate release action and are never implicitly
rolled back with Worker code.

## Runtime binding inventory

Status is based on repository inspection plus a read-only `wrangler secret
list` against the production Worker on 2026-09-12. Presence confirms only that
a binding exists, not that its value, mode, permissions, or delivery path works.
Never add secret values to this document.

| Binding | Class | Consumers | Owner | Production status and verification |
| --- | --- | --- | --- | --- |
| `ASSETS` | Cloudflare-managed binding | All static pages/assets | Cloudflare | Defined in `wrangler.toml`; verify all browser smoke assets return 200 |
| `SUPABASE_URL` | Public config | CourierIQ and all four MVPs | Database/Auth | Defined in `wrangler.toml`; verify it targets the approved production project |
| `SUPABASE_PUBLISHABLE_KEY` | Public credential | Browser/Auth flows for all four MVPs | Database/Auth | Defined in `wrangler.toml`; safe to expose, but effective access still depends on grants and RLS |
| `SUPABASE_SECRET_KEY` | Secret | Server-side database access for CourierIQ and all four MVPs | Database/Auth | Binding name confirmed; verify backend requests and ensure it never reaches browser code |
| `STRIPE_PUBLISHABLE_KEY` | Public credential | Chargeback Studio Payment Element | Payments | Configured in the production Worker; live mode matches the Stripe secret |
| `STRIPE_SECRET_KEY` | Secret | PaymentIntent/Checkout creation and verification | Payments | Configured in the production Worker; live mode matches the publishable key |
| `STRIPE_WEBHOOK_SECRET` | Secret | Shared signed webhook and fallback for BidLens/ScopeFence handlers | Payments | Binding name confirmed; verify a signed event at `/api/stripe/webhook` grants exactly one entitlement |
| `BIDLENS_STRIPE_WEBHOOK_SECRET` | Optional secret | Dedicated BidLens webhook endpoint | Payments | Not configured by design; the product uses the shared webhook secret unless a separate Stripe destination is created |
| `SCOPEFENCE_STRIPE_WEBHOOK_SECRET` | Optional secret | Dedicated ScopeFence webhook endpoint | Payments | Not configured by design; the product uses the shared webhook secret unless a separate Stripe destination is created |
| `STRIPE_CHARGEBACK_TAX_CODE` | Optional config | Chargeback Studio tax calculation | Payments | Not required when the Stripe account preset tax code is correct; verify one test calculation before live mode |
| `RESEND_API_KEY` | Secret | CourierIQ and Chargeback Studio email | Email | Binding name confirmed; verify sender domains and both applicant/operator delivery paths |
| `TURNSTILE_SECRET_KEY` | Secret | CourierIQ intake and all MVP sign-in challenges | Cloudflare | Binding name confirmed; verify the production hostname and expected action for each flow |
| `OPENAI_API_KEY` | Secret | BidLens and ScopeFence analysis | AI | Configured in the production Worker on 2026-09-12 using the `IDI Website Production` service account; API billing is not funded, so model-access verification remains blocked |
| `BIDLENS_OPENAI_MODEL` | Optional config | BidLens analysis | AI | Not configured; code uses its reviewed default until explicitly overridden |
| `SCOPEFENCE_OPENAI_MODEL` | Optional config | ScopeFence analysis | AI | Not configured; code next checks `OPENAI_MODEL`, then its reviewed default |
| `OPENAI_MODEL` | Optional config | ScopeFence fallback model | AI | Not configured; keep unset unless one shared override is intentional |
| `BETA_INVITE_URL` | Controlled value | CourierIQ approval email | Product/Cloudflare | **Not configured; release blocker for sending beta invitations** |
| `CHARGEBACK_STUDIO_URL` | Public config | Chargeback Studio links and email | Cloudflare | Defined in `wrangler.toml`; verify the production route returns the current page |
| `EVIDENCELANE_ORIGIN` | Legacy public config | Chargeback Studio compatibility fallback | Cloudflare | Defined in `wrangler.toml`; retain until legacy cleanup proves it is unused |

The Supabase publishable key is intentionally client-safe. The Supabase secret
key bypasses RLS and belongs only in the Worker. The OpenAI API key is likewise
server-only and must never be embedded in a browser bundle.

For local work, copy `.dev.vars.example` to `.dev.vars`. The populated file is
ignored by Git. Use `.dev.vars` or `.env`, not both.

## Current release blockers

Do not promote every product to Live until all applicable items are resolved:

- Fund the OpenAI API account, then verify BidLens and ScopeFence model access,
  failure behavior, cost, latency, and credit safety. The production service key
  is already stored as an encrypted Cloudflare secret.
- Add `BETA_INVITE_URL` as a controlled Cloudflare value and complete the
  CourierIQ applicant-to-installed-build path.
- Reconcile and apply the pending Supabase migration only through the database
  procedure below.
- Fix the `www` hostname, publish legal/support pages, add required deletion
  controls, and configure production monitoring.

No second paid Supabase branch is required by this runbook. Schema changes must
first pass a clean local disposable database validation. If an existing
no-additional-cost pre-production environment is available, use it; otherwise
the release owner can approve the production migration after backup and
migration-history checks.

## Candidate preparation

1. Record the release owner, product owner, date, branch, and candidate commit.
2. Confirm `git status --short` is empty and the candidate contains only
   reviewed changes.
3. Run the locked build and automated gates:

   ```powershell
   npm ci
   npx playwright install chromium
   npm run check
   ```

4. Confirm the GitHub `Build, test, and package` job is green for the exact
   commit. Do not substitute a prior commit's result.
5. Confirm generated bundles remain clean after the build with
   `git status --short`.
6. Review `PRODUCTION_RELEASE_PLAN.md` and stop if any product-specific P0 gate
   for the intended release remains open.

## Configuration preflight

1. Inspect binding names without retrieving values:

   ```powershell
   npx wrangler secret list
   ```

2. Compare the result with the inventory above. Required secrets for the
   products being released must exist. Optional per-product Stripe webhook
   secrets may remain absent while the shared endpoint is used.
3. Review `[vars]` in `wrangler.toml`. Treat this file as the source of truth
   for public Worker configuration because a deployment can overwrite values
   changed only in the dashboard.
4. Confirm Supabase project identity, Stripe account and mode, Resend sending
   domain, Turnstile hostname/actions, OpenAI project/model access, and the
   CourierIQ invitation target with their owners.
5. Do not use `/api/health` as proof that an integration works. Its deliberately
   minimal response proves only that the Worker request path is alive.

For a new or rotated secret, run the full automated gate first. Then use the
Cloudflare dashboard or `npx wrangler secret put <BINDING>` knowing that the
command creates and immediately deploys a new Worker version. Verify the new
version before revoking the old provider credential.

## Database release

Database changes have a separate go/no-go decision from the Worker deployment.
Do not run these commands merely because the application build is green.

1. Validate every migration from an empty local database and retain the result
   in the release record. The current repository migrations have already passed
   an isolated PostgreSQL-compatible baseline check; rerun it for the exact
   release commit.
2. In Supabase Dashboard, confirm a usable backup exists before the proposed
   change and record its timestamp and expected recovery point.
3. Link an organization-approved Supabase CLI to the intended project and
   compare local and remote history:

   ```powershell
   supabase migration list
   ```

4. Stop on a missing, duplicated, renamed, or unexpected migration. Reconcile
   history explicitly; never edit an already-applied migration to make the list
   appear clean.
5. Review the pending SQL, locks, index build impact, RLS, grants, destructive
   statements, expected duration, and application compatibility.
6. After explicit database release approval, apply migrations:

   ```powershell
   supabase db push
   supabase migration list
   ```

7. Confirm the expected migration versions are present, query the changed
   objects, run Supabase security/performance advisors, and record results.
8. If the database step fails, stop the Worker release. Prefer a reviewed
   forward fix. Do not improvise a down migration against customer data.

For the current candidate, this procedure must reconcile the pre-history beta
schema record and the release-hardening migration before promotion.

## Worker deployment

1. Reconfirm the exact candidate commit and database go/no-go result.
2. Announce the release window and select the last known-good Worker version.
   Find version IDs with:

   ```powershell
   npx wrangler deployments list
   ```

3. Deploy the already-verified candidate:

   ```powershell
   npm run deploy
   ```

4. Record the resulting Cloudflare version ID, deployment time, commit, and
   operator. Do not call the release complete yet.

## Post-deploy checks

Run these against the production apex domain immediately after deployment:

1. Confirm the homepage, ADBridge, CourierIQ, Chargeback Studio, Revenue Leak
   Finder, BidLens, ScopeFence, privacy page, sitemap, robots file, and icon all
   return expected statuses.
2. Run the production browser smoke suite:

   ```powershell
   $env:PLAYWRIGHT_TEST_BASE_URL = "https://intelligentdecisions.io"
   npm run test:browser
   Remove-Item Env:PLAYWRIGHT_TEST_BASE_URL
   ```

3. Confirm `/projects/evidencelane/` returns a permanent redirect to Chargeback
   Studio and does not present EvidenceLane as a separate product.
4. Confirm `/api/health` returns exactly `{ "success": true, "status": "ok" }`
   with HTTP 200; verify integrations through their actual product journeys.
5. Confirm unauthenticated account/admin endpoints fail closed.
6. Complete the intended product's manual journey, including authentication,
   retained data, deletion where promised, payment and entitlement where
   applicable, and operator notifications.
7. For payments, confirm the signed webhook event, exact entitlement quantity,
   idempotent replay, and no grant for failed/unpaid events. Follow
   `STRIPE_SETUP.md` for the routing contract.
8. Watch Cloudflare, Supabase, Stripe, Resend, and OpenAI error surfaces during
   the release window. Record evidence and the final go/no-go decision.

The `www` hostname must pass the same checks before it is advertised. It was
returning HTTP 522 at the last audit and remains a release blocker.

## Application rollback

Rollback the Worker when a newly introduced application failure is materially
harming users and a rapid forward fix is less safe.

1. Stop additional releases and identify the last known-good version from
   `npx wrangler deployments list`.
2. Confirm that version is compatible with the current database schema and
   bindings. Cloudflare rollback does not revert Supabase or other connected
   resources.
3. With release-owner approval, run:

   ```powershell
   npx wrangler rollback <VERSION_ID> --message "Rollback: <incident reference>"
   ```

4. Repeat the production browser smoke and affected product journey.
5. Record the new rollback deployment ID, impact window, root cause, data
   reconciliation needed, and forward-fix owner.

Do not roll the database backward solely because the Worker was rolled back.
Additive schema changes should remain compatible with the previous Worker. If
they are not, treat that as a release-design defect and choose a reviewed
forward fix or the database recovery procedure.

## Database recovery

A backup restore is an incident action, not a normal deployment rollback. It
causes database downtime and may discard valid transactions after the selected
restore point.

1. Freeze writes as far as the product allows and record the incident time,
   suspected corruption window, last known-good transaction, and affected
   products.
2. Have the database owner and release owner choose the closest verified backup
   before the incident. Quantify the expected data-loss window.
3. Export any still-valid reconciliation data needed after the restore.
4. Use Supabase Dashboard **Database > Backups** to perform the approved restore.
   Do not script a restore during the first production launch.
5. Expect the project to be inaccessible during restoration.
6. After restore, reset custom-role passwords if any are used; daily backups do
   not retain them.
7. Remember that database backups contain Storage metadata, not deleted Storage
   objects. Reconcile Chargeback Studio evidence objects separately.
8. Re-run `supabase migration list`, verify RLS/grants and critical row counts,
   run advisors, then test authentication and every affected product flow.
9. Reconcile Stripe events, entitlements, email state, and user writes that
   occurred after the restore point before reopening normal traffic.

## Credential rotation

Use an overlap-first rotation whenever the provider supports two active keys:

1. Create a new least-privilege provider credential without revoking the old.
2. Run the candidate checks, update the matching Cloudflare binding, and verify
   the resulting deployment.
3. Exercise the integration from the server and inspect provider logs.
4. Revoke the old credential only after the new path is proven.
5. Record owner, time, reason, affected products, and next rotation date.

Special cases:

- Supabase: the publishable key is client-side; the secret key is backend-only
  and bypasses RLS. Rotate them independently and verify Auth plus service calls.
- Stripe: rotate the API key and webhook signing secret as distinct credentials.
  Do not expire an old webhook secret until a signed test event succeeds.
- OpenAI: store the key only in the Worker. Verify BidLens and ScopeFence, then
  revoke the prior key; log provider request IDs for production troubleshooting.
- Resend: prove applicant, operator, and Chargeback Studio delivery before
  revoking the previous key.
- Turnstile: verify the production hostname and action on every protected form
  after the secret changes.

## Stop conditions

Stop the release and preserve evidence when any of the following occurs:

- CI or browser smoke is not green for the exact commit.
- A required binding is missing, belongs to the wrong environment, or cannot be
  verified without exposing its value.
- Migration history differs from the reviewed repository.
- Backup readiness or rollback compatibility is unknown.
- Authentication, payment signature verification, entitlement idempotency,
  deletion, or privacy controls fail for the product being released.
- Error rates rise materially or customer data integrity is uncertain.

## Release record template

```text
Release:
Date/window:
Release owner:
Cloudflare owner:
Database/Auth owner:
Payments owner:
Email owner:
AI owner:
Product owner:
Branch and commit:
CI run URL/result:
Local check result:
Binding preflight result:
Database migration versions/result:
Backup timestamp/recovery point:
Supabase advisor result:
Previous Worker version:
New Worker version:
Production smoke result:
Manual product journey result:
Monitoring result:
Go/no-go decision:
Rollback trigger and owner:
Follow-up issues:
```

## Provider references

- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Supabase environment and migration management](https://supabase.com/docs/guides/deployment/managing-environments)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase publishable and secret key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [OpenAI API authentication and production guidance](https://developers.openai.com/api/reference/overview)
