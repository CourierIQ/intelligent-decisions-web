# Production release record — 2026-09-12

Release: IDI public website, ADBridge flagship surface, and web MVP release candidates

Date/window: September 12, 2026, 9:27–9:48 PM America/New_York

Branch and commit: `dev` at `35136bfbd67c5b7dee7f6668222faf2932275c38`

CI run: https://github.com/Intelligent-Decisions-Interactive/Intelligent-Decisions/actions/runs/34731332643 — success

Local gate: 32/32 repository tests, 26/26 local Chromium desktop/mobile checks, generated-bundle validation, and 58-asset Worker dry run passed.

Binding preflight:

- Present: Supabase URL/publishable/server keys, Turnstile, Resend, Stripe secret/publishable/webhook keys, and the OpenAI production service key.
- Matching Stripe live mode confirmed when the production payment-config endpoint reached its authenticated boundary rather than returning a configuration failure.
- Not present: `BETA_INVITE_URL`. The OpenAI service key was added after the application release, but the API account is not funded and no billable production AI request has been made. BidLens and ScopeFence remain pre-launch; CourierIQ invitations remain a controlled manual/private-beta step.

Database release:

- The production Supabase project was active and healthy on Postgres 17.
- Pro-plan daily backup availability was confirmed. The exact latest backup timestamp was not exposed by the connected release tooling.
- Legacy migration `20260711_add_google_play_email` was verified in schema and reconciled as applied.
- Applied `20260913013045_release_database_hardening`.
- Applied `20260913013100_scopefence_customer_data_deletion`.
- Remote and repository history now contain the same 17 versions.
- Verified both CourierIQ foreign-key indexes, nullable ScopeFence payment-audit ownership with `ON DELETE SET NULL`, service-role-only fulfillment execution, and absence of workspace recreation in the fulfillment function.
- Post-release advisors cleared the two missing-index findings. Remaining security findings are the documented intentional Chargeback provisioning RPC and disabled leaked-password protection.

Cloudflare release:

- The previous and final Worker versions are retained in Cloudflare deployment history for rollback.
- Apex custom domain and `www.intelligentdecisions.io/*` Worker route are active.
- Persistent Worker logs and 100% launch-window sampling are enabled.
- `OPENAI_API_KEY` was added as an encrypted Worker secret using the project-scoped `IDI Website Production` service account. The secret value was not written to the repository or release record.

Production verification:

- Homepage, ADBridge, CourierIQ, Chargeback Studio, Revenue Leak Finder, BidLens, ScopeFence, privacy, terms, support, contact, sitemap, robots, and icon returned HTTP 200.
- `www` permanently redirects to the apex while preserving path/query.
- EvidenceLane permanently redirects to Chargeback Studio while preserving query.
- `/api/health` returned exactly `{ "success": true, "status": "ok" }` with HTTP 200.
- Product account endpoints failed closed without authentication; the beta admin API redirected to Cloudflare Access.
- 26/26 production Chromium desktop/mobile checks passed after correcting the Cloudflare Web Analytics CSP allowance.
- Invalid-input probes for beta intake and all email-code entry points were rejected before writes or email delivery.

Go/no-go decision:

- GO: public website, ADBridge flagship marketing surface, company pages, Revenue Leak Finder release-candidate surface, Chargeback Studio preview, and the BidLens/ScopeFence pre-launch surfaces.
- HOLD: labeling BidLens or ScopeFence live until API billing is funded and an authenticated AI journey passes.
- HOLD: automated CourierIQ invitations until an owner supplies the approved `BETA_INVITE_URL` and the applicant-to-install journey passes.
- HOLD: labeling paid product journeys live until real authenticated payment, signed webhook, exact entitlement, duplicate-event, cancellation/failure, and recovery checks are recorded.

Rollback trigger: material new application errors, customer-data integrity risk, authentication regression, or incorrect payment entitlement. Application rollback target is the last compatible Worker version recorded above; database changes remain forward-compatible and should not be rolled back ad hoc.
