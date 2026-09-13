-- Record the least-privilege grants already used by the Chargeback Studio
-- Worker, and add the two foreign-key indexes reported by the database
-- performance advisor. Every statement is safe to replay.

grant usage on schema public to service_role;

grant select, update
  on table public.chargeback_packs
  to service_role;

grant select
  on table public.chargeback_organization_members,
           public.chargeback_pack_disputes,
           public.chargeback_evidence_files
  to service_role;

grant select, insert, update
  on table public.evidencelane_orders
  to service_role;

grant select, insert
  on table public.stripe_webhook_events
  to service_role;

create index if not exists idx_courieriq_offer_score_components_offer_id
  on public.courieriq_offer_score_components (offer_id);

create index if not exists idx_courieriq_offer_score_components_user_id
  on public.courieriq_offer_score_components (user_id);
