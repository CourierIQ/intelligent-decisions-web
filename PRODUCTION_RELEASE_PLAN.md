# IDI Production Release Plan

Last audited: 2026-09-12

This is the canonical release checklist for the IDI web platform, flagship ADBridge release, CourierIQ product launch, and the four web MVPs. Update it whenever a blocker is resolved, a launch decision changes, or a production check is completed.

## Portfolio map

| Product | Release track | Current state | Target state |
| --- | --- | --- | --- |
| ADBridge | Flagship product | The flagship marketing surface is live; Developer and Enterprise products remain on their separate release tracks | Release-ready Developer distribution and controlled Enterprise Early Access with a clear public product path |
| CourierIQ | Primary product launch | Beta intake and admin infrastructure are live; invitation delivery is not configured | Controlled production beta with a verified applicant-to-first-sync journey |
| Chargeback Studio | MVP | Page is deployed, but production authentication and payments are blocked | Authenticated dispute workspace with paid response-pack export |
| Revenue Leak Finder | MVP | Core implementation is deployed and has no known code blocker | Verified free analysis and paid-credit workflow |
| BidLens | MVP | UI, account, payment, and analysis code are deployed; AI is not configured | Verified document analysis with grounded outputs and paid credits |
| ScopeFence | MVP | Production UI, schema, payment routing, and customer deletion controls are deployed; AI is not configured | Verified scope analysis with safe storage, deletion, and paid credits |

EvidenceLane is the former name of Chargeback Studio. Historical database and migration identifiers may retain the old name where renaming would create migration risk. Customer-facing references should use Chargeback Studio.

## Release order

1. Stabilize the shared production baseline.
2. Prepare and release ADBridge as the flagship product.
3. Release Revenue Leak Finder.
4. Open the CourierIQ controlled beta.
5. Release Chargeback Studio.
6. Release BidLens.
7. Release ScopeFence.

The order can change for business reasons, but no product bypasses the shared production gates.

## Shared production gates

### P0 — Reproducible source and deployment

- [x] Establish a reviewed, separately staged web/application release baseline for ADBridge and the four MVPs.
- [x] Add a repository ignore boundary for dependencies, local runtime state, environment files, and machine metadata.
- [x] Remove previously tracked Wrangler cache and local request metadata from the release boundary without deleting the local files.
- [x] Generate a dependency lockfile.
- [x] Include the dependency lockfile in the reviewed web/application release baseline.
- [x] Confirm the lockfile can recreate dependencies with npm ci, run the tests, and build all production bundles.
- [x] Reconcile Supabase migration version names. All fourteen production migrations now have SQL-equivalent local files with the exact production versions.
- [x] Reconcile the pre-history beta schema migration and the forward release-hardening migration with remote migration history during the controlled database release.
- [x] Check in the initial CourierIQ and beta-intake schemas so a fresh environment can be recreated from the repository.
- [ ] Add a disposable or existing no-additional-cost pre-production deployment and require successful checks before production deployment. Do not create a paid persistent Supabase branch solely for testing.
- [x] Document deployment, environment configuration, rollback, and database-recovery procedures in `PRODUCTION_RUNBOOK.md`.

### P0 — Domain, routing, and browser security

- [x] Route www.intelligentdecisions.io through the production Worker and permanently redirect it to the apex domain.
- [x] Replace the EvidenceLane HTML meta-refresh with a permanent HTTP 308 redirect to Chargeback Studio, with a clear static fallback for direct asset previews.
- [x] Repair the production Content Security Policy for Chargeback Studio:
  - Bundle the pinned Supabase browser client with the application.
  - Permit only the exact Supabase API and WebSocket origins in connect-src.
  - Permit the Stripe-documented script, API, image, and frame origins only on the Chargeback Studio route.
  - Permit blob images only on the Chargeback Studio route for local evidence-file previews.
- [x] Replace the missing /favicon.svg references in BidLens and ScopeFence with the existing site icon.
- [x] Add a repeatable automated Chromium smoke check for desktop and mobile that fails on CSP violations, missing assets, console errors, page errors, or horizontal overflow.

### P0 — Security, privacy, and customer controls

- [x] Build company privacy, terms, support, and contact pages and link the release candidate from every active product.
- [ ] Complete owner/legal review of the company privacy and terms copy, then publish it to production.
- [x] Document product-specific data collection, retention, deletion, and subprocessors in the shared privacy notice without obscuring unresolved product controls.
- [ ] Provide account deletion and history/data deletion wherever customer data is retained.
- [ ] Enable Supabase leaked-password protection before opening password-based Chargeback Studio signup.
- [x] Review the authenticated Chargeback provisioning SECURITY DEFINER function. Its public RPC binds all work to auth.uid(), rejects unauthenticated calls, and grants execution only to authenticated users; the current advisor finding is intentional.
- [ ] Exercise Chargeback provisioning with a real authenticated staging session before launch.
- [x] Confirm all 36 public product tables have RLS enabled. Twenty-eight server-only tables intentionally expose no client policies and therefore fail closed outside privileged backend access.
- [x] Reduce the public health response to an exact liveness payload that does not enumerate configured services.

### P0 — Production integrations

- [x] Create an environment-variable inventory with owner, environment, rotation procedure, and verification status.
- [ ] Verify Turnstile, Supabase Auth, Resend, Stripe, and OpenAI in staging and production.
- [x] Document and test the mixed PaymentIntent/Checkout routing contract and all required Stripe webhook event subscriptions.
- [ ] Test Stripe webhook signature validation, idempotency, delayed events, failed payments, refunds, and replay/recovery.
- [ ] Confirm every paid product grants exactly the purchased entitlement and cannot grant it from a browser-only action.

### P1 — Quality and operations

- [x] Add CI checks for clean install, production builds, unit tests, generated-bundle drift, Worker dry runs, broken links, and missing static assets.
- [ ] Add explicit linting and static type checking once the current JavaScript/TypeScript boundary is formalized.
- [ ] Add desktop and mobile end-to-end tests for each product's primary user journey.
- [ ] Add accessibility checks for authentication, upload, checkout, report, and export screens.
- [ ] Configure Cloudflare error monitoring and alerts.
- [ ] Monitor Supabase database health, authentication failures, storage failures, and backup/recovery readiness.
- [ ] Monitor Stripe webhook failures and provide an operator replay procedure.
- [x] Add a release checklist with smoke tests and an explicit rollback decision point.
- [x] Add covering indexes for courieriq_offer_score_components.offer_id and user_id to the generated forward release-hardening migration.
- [x] Validate the release-hardening migration in an isolated PostgreSQL-compatible runtime, apply it through the controlled production database release, and confirm the performance advisor clears both findings.
- [x] Replace premature homepage Live badges with explicit beta, release-candidate, and pre-launch states while preserving ADBridge as the flagship.

## Product launch gates

### ADBridge — flagship product

- [x] Add a public-safe ADBridge product page covering Developer, Enterprise Early Access, AI integration, security boundaries, architecture, use cases, and edition comparison.
- [x] Make ADBridge the front-facing flagship product on the IDI homepage.
- [x] Link ADBridge Developer to its public GitHub repository without exposing Enterprise source.
- [x] Clearly distinguish the MIT-licensed Developer edition from proprietary Enterprise Early Access.
- [ ] Review and commit the extensive current changes in both ADBridge repositories as intentional release baselines.
- [ ] Complete the ADBridge Developer host and Android validation suites from the exact release commit.
- [ ] Fix the ADBridge Enterprise release validation failure caused by the missing ADBridgeEnterpriseUninstall.cs source file.
- [ ] Complete the full ADBridge Enterprise validation suite from the exact release commit.
- [ ] Resolve version alignment across source packages, Android artifacts, release bundles, changelogs, and public messaging.
- [ ] Complete the Developer public-source and Git-history secret review before changing repository visibility or publishing a release.
- [ ] Obtain and integrate Authenticode signing for public or paid Enterprise distribution; integrity manifests alone do not establish publisher identity or SmartScreen reputation.
- [ ] Produce clean, reviewed, traceable Developer and Enterprise release candidates and validate installation, upgrade, rollback, and uninstall on supported Windows and Android configurations.
- [ ] Define the operational owner and response path for Enterprise Early Access inquiries.
- [x] Deploy and smoke-test the ADBridge marketing page on the apex and www hostnames.

Release gate: clean reviewed commits, all prescribed Developer and Enterprise checks passing, signed and traceable distributions, a verified physical-device workflow, and an operational Early Access path.

### Revenue Leak Finder — first MVP candidate

- [x] Core CSV parsing, matching, report, and formula-injection tests pass.
- [x] The unauthenticated production account endpoint fails closed.
- [x] Supabase, Turnstile, Stripe secret, and webhook configuration are present.
- [ ] Complete a clean new-user browser test: Turnstile, email OTP, upload, match, first free report, history, and CSV export.
- [ ] Complete a Stripe test purchase and confirm the webhook grants the exact credit quantity once.
- [ ] Test payment cancellation, delayed payment, duplicate webhook delivery, and failed webhook recovery.
- [ ] Publish product privacy and retention terms.
- [ ] Add account/history deletion.
- [ ] Add production funnel and error monitoring.

Release gate: one clean end-to-end free flow, one clean paid flow, published customer terms, and active alerts.

### CourierIQ — controlled product beta

- [x] Public beta intake is deployed and has stored real requests.
- [x] The admin API is protected by Cloudflare Access.
- [x] Supabase, Turnstile, and Resend configuration are present.
- [ ] Configure BETA_INVITE_URL.
- [ ] Verify applicant submission, admin review, approval, invite email, Google Play access, install, first synchronization, and feedback intake.
- [ ] Publish beta privacy, retention, deletion, support, and participation terms.
- [x] Check in the full database baseline needed to recreate CourierIQ and beta intake.
- [ ] Document Android build, signing, Play distribution, versioning, rollback, and support ownership outside this web repository.
- [x] Stage the two recommended foreign-key indexes for courieriq_offer_score_components in the forward release-hardening migration.
- [ ] Validate the indexes in a clean disposable local database, then apply them through the controlled production database release and confirm query plans and write latency.

Release gate: a new beta applicant can reach a working installed build without manual database intervention, and the team can support or roll back that build.

### Chargeback Studio

- [x] Workspace, storage, entitlement, payment-intent, and webhook code are present.
- [x] The evidence storage bucket is private and restricts file size and MIME types.
- [x] Fix CSP so the bundled Supabase client and Stripe load from the product's explicitly allowed origins; the local browser gate now verifies the account screen initializes without CSP errors.
- [ ] Configure STRIPE_PUBLISHABLE_KEY.
- [ ] Verify account creation, email verification if required, sign-in, sign-out, session recovery, and password reset.
- [ ] Verify dispute creation, file upload, readiness check, preview, paid export, history, and dispute deletion.
- [ ] Verify storage cleanup and add retry/reconciliation for orphaned files when database deletion succeeds but storage deletion fails.
- [ ] Complete Stripe tests for all three pack sizes.
- [ ] Publish product privacy, retention, deletion, merchant-data, and non-legal-advice terms.
- [ ] Remove remaining customer-facing EvidenceLane references.

Release gate: no CSP errors, complete auth recovery, one verified export for every price tier, reliable deletion, and published customer terms.

### BidLens

- [x] UI, account, credit, Stripe, analysis, history, and deletion code are present.
- [x] A product privacy page exists.
- [x] The analysis request uses the OpenAI Responses API with storage disabled and structured output.
- [ ] Configure OPENAI_API_KEY and confirm production model access.
- [ ] Test PDF, DOC, DOCX, RTF, ODT, TXT, and Markdown fixtures at small, large, malformed, and maximum supported sizes.
- [ ] Build a reviewed golden set for requirements, deadlines, evaluation criteria, ambiguities, and evidence citations.
- [ ] Define acceptable accuracy, grounding, latency, timeout, and per-analysis cost thresholds.
- [ ] Verify that failures do not consume credits.
- [ ] Complete a Stripe credit purchase and duplicate-webhook test.
- [ ] Expand customer terms for uploaded procurement documents, retention, deletion, and AI processing.

Release gate: the golden set meets its quality thresholds, failures are credit-safe, payments are idempotent, and uploaded source documents are handled according to published terms.

### ScopeFence

- [x] UI, account, workspace, credit, Stripe, analysis, history, and change-order generation code are present.
- [x] The analysis request uses the OpenAI Responses API with storage disabled and structured output.
- [ ] Configure OPENAI_API_KEY and confirm production model access.
- [x] Add release-candidate APIs and UI for deleting saved scopes, embedded client requests, analyses, history, and the ScopeFence product account without deleting the shared IDI Auth identity.
- [x] Apply and verify the ScopeFence deletion migration so payment audit rows detach from deleted accounts and delayed Stripe events cannot recreate a deleted workspace.
- [x] Publish the ScopeFence privacy, retention, AI-processing, and deletion disclosures before accepting customer agreements.
- [ ] Decide whether full source agreements must be retained; minimize or make retention opt-in where practical.
- [ ] Build a reviewed golden set for included, ambiguous, and out-of-scope requests.
- [ ] Define acceptable classification accuracy, grounding, latency, timeout, and per-analysis cost thresholds.
- [ ] Verify that failures do not consume credits.
- [ ] Complete a Stripe credit purchase and duplicate-webhook test.

Release gate: customer data is controllable and deletable, the golden set meets its quality thresholds, failures are credit-safe, and payments are idempotent.

## Historical EvidenceLane cleanup

- [ ] Remove stale links to the previous externally hosted EvidenceLane experience.
- [ ] Use Chargeback Studio in all customer-facing copy, metadata, navigation, analytics, and support material.
- [ ] Document legacy EvidenceLane database and migration names so they are not mistaken for a separate active product.
- [ ] Preserve historical identifiers when renaming them would create unnecessary production migration risk.

## Current production configuration snapshot

Configuration detected as present (binding names rechecked against the live Worker on 2026-09-12):

- Supabase URL, publishable key, and server secret
- Resend
- Turnstile
- Stripe secret key
- Stripe publishable key
- Shared Stripe webhook configuration used by BidLens and ScopeFence fallback routing

Required production configuration detected as missing:

- OPENAI_API_KEY
- BETA_INVITE_URL

Never put secret values in this document.

## Verification record

- [x] Thirty-two repository tests, including ADBridge marketing, legacy routing, asset, Chargeback Studio CSP, loopback/production routing, minimal public health output, cross-product Stripe routing, production-host configuration, release-binding inventory, and ScopeFence deletion authorization regressions, pass on the release candidate.
- [x] Main product pages and compiled product bundles returned HTTP 200.
- [x] The CourierIQ admin API redirected unauthenticated access to Cloudflare Access.
- [x] Product account APIs rejected unauthenticated requests.
- [x] A live browser check reproduced Chargeback Studio's blocked Supabase and Stripe libraries.
- [x] The www hostname failure was reproduced.
- [x] All Revenue Leak Finder, BidLens, and ScopeFence browser bundles built successfully after npm ci.
- [x] Wrangler completed a production Worker and 58-asset dry run without deploying.
- [x] npm reported zero known dependency vulnerabilities on 2026-09-12.
- [x] Chargeback Studio passed a local browser smoke check with its bundled Supabase client: the account screen initialized, required assets loaded, no horizontal overflow appeared, and the console remained clean.
- [x] Twenty-six repeatable Chromium checks cover the homepage, ADBridge, CourierIQ, all four MVPs, the four company information pages, the legacy EvidenceLane redirect, and the ScopeFence deletion controls across desktop and mobile layouts.
- [x] The same twenty-six Chromium checks passed against production after deployment with no CSP violations, console errors, failed same-origin requests, missing assets, or horizontal overflow.
- [x] The apex and www hostnames, permanent legacy redirect, minimal health response, protected account APIs, and Cloudflare Access admin boundary passed production HTTP smoke checks.
- [x] Cloudflare Worker invocation/error logs and Web Analytics now load under the production CSP.
- [x] Chargeback Studio's production payment configuration reached the sign-in boundary, confirming matching live-mode Stripe publishable and secret bindings without creating a PaymentIntent.
- [x] Supabase production advisors and schema metadata were reviewed on 2026-09-12: all 36 public product tables have RLS enabled; remaining security warnings are the intentional self-provisioning RPC and disabled leaked-password protection.
- [x] All seventeen production migration versions are reconciled to local filenames, including the legacy beta baseline, Chargeback Studio Worker grants, CourierIQ foreign-key indexes, and ScopeFence customer-deletion safeguards.
- [x] The production database verified the ScopeFence payment-audit `SET NULL` relationship, service-role-only fulfillment RPC, webhook non-recreation safeguard, and both CourierIQ covering indexes after migration.
- [x] The reconstructed CourierIQ and beta-intake baseline matches production's 14 tables, 209 columns, 40 named constraints, and 32 existing indexes; it executed successfully with the RLS and hardening migrations in an isolated PostgreSQL-compatible runtime.
- [ ] No complete browser-level authentication, payment, webhook, email, or AI journey has been verified yet.

## Universal definition of done

A product may be labeled Live only when:

- [ ] Its primary new-user journey succeeds on desktop and mobile.
- [ ] Authentication recovery and sign-out work.
- [ ] Payment and entitlement behavior is verified, when applicable.
- [ ] Customer data can be exported or deleted as promised.
- [ ] Privacy, terms, support, and retention information are published.
- [ ] Production errors and integration failures are monitored.
- [ ] A rollback procedure is documented and usable.
- [ ] The release commit, database migrations, assets, and deployed version are traceable.
