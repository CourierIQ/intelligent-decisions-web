set local lock_timeout = '5s';

drop policy chargeback_packs_insert_member on public.chargeback_packs;

create policy chargeback_packs_insert_member
on public.chargeback_packs for insert to authenticated
with check (
  private.chargeback_is_member(organization_id)
  and created_by = (select auth.uid())
  and status in ('draft', 'preview')
  and stripe_checkout_session_id is null
  and unlocked_at is null
);

revoke update on table public.chargeback_packs from authenticated;
grant update (name, readiness_score, case_count, file_count)
on table public.chargeback_packs to authenticated;

comment on column public.chargeback_packs.status is
  'Entitlement state. Only the trusted payment backend may set payment_pending or unlocked.';
