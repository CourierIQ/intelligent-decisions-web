set local lock_timeout = '5s';

alter table public.chargeback_packs
  add column stripe_payment_intent_id text,
  add constraint chargeback_packs_stripe_payment_intent_id_key
    unique (stripe_payment_intent_id),
  add constraint chargeback_packs_stripe_payment_intent_id_check
    check (
      stripe_payment_intent_id is null or
      char_length(stripe_payment_intent_id) between 8 and 255
    );

alter table public.evidencelane_orders
  alter column stripe_checkout_session_id drop not null,
  add constraint evidencelane_orders_stripe_payment_intent_id_key
    unique (stripe_payment_intent_id),
  add constraint evidencelane_orders_stripe_payment_intent_id_check
    check (
      stripe_payment_intent_id is null or
      char_length(stripe_payment_intent_id) between 8 and 255
    ),
  add constraint evidencelane_orders_payment_reference_check
    check (
      stripe_checkout_session_id is not null or
      stripe_payment_intent_id is not null
    );

alter table public.evidencelane_orders
  drop constraint evidencelane_orders_tier_check,
  drop constraint evidencelane_orders_case_count_check,
  add constraint evidencelane_orders_tier_check
    check (
      (tier_code = 'single' and offer_code = 'evidencelane_pack_20' and file_count <= 20) or
      (tier_code = 'multi' and offer_code = 'evidencelane_pack_50' and file_count <= 50) or
      (tier_code = 'volume' and offer_code = 'evidencelane_pack_100' and file_count <= 100)
    ),
  add constraint evidencelane_orders_case_count_check
    check (case_count between 1 and 10000);

drop policy chargeback_packs_insert_member on public.chargeback_packs;

create policy chargeback_packs_insert_member
on public.chargeback_packs for insert to authenticated
with check (
  private.chargeback_is_member(organization_id)
  and created_by = (select auth.uid())
  and status in ('draft', 'preview')
  and stripe_checkout_session_id is null
  and stripe_payment_intent_id is null
  and unlocked_at is null
);

comment on column public.chargeback_packs.stripe_payment_intent_id is
  'Trusted server-owned Stripe PaymentIntent reference for the on-site payment flow.';

comment on column public.evidencelane_orders.stripe_checkout_session_id is
  'Legacy Stripe Checkout reference. New Chargeback Studio payments use stripe_payment_intent_id.';
