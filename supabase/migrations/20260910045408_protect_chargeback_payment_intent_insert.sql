revoke insert on table public.chargeback_packs from authenticated;

grant insert (
  organization_id,
  created_by,
  name,
  status,
  tier_code,
  case_count,
  file_count,
  readiness_score
) on table public.chargeback_packs to authenticated;

comment on column public.chargeback_packs.stripe_payment_intent_id is
  'Trusted server-owned Stripe PaymentIntent reference. Authenticated clients have no INSERT or UPDATE privilege on this column.';
