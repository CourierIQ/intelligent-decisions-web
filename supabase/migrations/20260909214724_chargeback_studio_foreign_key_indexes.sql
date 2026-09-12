set local lock_timeout = '5s';

create index chargeback_members_user_idx
  on public.chargeback_organization_members (user_id, organization_id);
create index chargeback_organizations_creator_idx
  on public.chargeback_organizations (created_by);
create index chargeback_disputes_creator_idx
  on public.chargeback_disputes (created_by);
create index chargeback_disputes_assignee_idx
  on public.chargeback_disputes (assigned_to)
  where assigned_to is not null;
create index chargeback_evidence_creator_idx
  on public.chargeback_evidence_files (created_by);
create index chargeback_evidence_dispute_org_idx
  on public.chargeback_evidence_files (dispute_id, organization_id);
create index chargeback_packs_creator_idx
  on public.chargeback_packs (created_by);
create index chargeback_pack_disputes_pack_org_idx
  on public.chargeback_pack_disputes (pack_id, organization_id);
create index chargeback_pack_disputes_dispute_org_idx
  on public.chargeback_pack_disputes (dispute_id, organization_id);
create index chargeback_events_actor_idx
  on public.chargeback_dispute_events (actor_id)
  where actor_id is not null;
create index chargeback_events_dispute_org_idx
  on public.chargeback_dispute_events (dispute_id, organization_id);
create index evidencelane_orders_organization_idx
  on public.evidencelane_orders (organization_id)
  where organization_id is not null;
create index evidencelane_orders_user_idx
  on public.evidencelane_orders (user_id)
  where user_id is not null;
