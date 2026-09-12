set local lock_timeout = '5s';

alter table public.evidencelane_orders
  drop constraint evidencelane_orders_offer_code_check,
  add column batch_id text,
  add column tier_code text,
  add column case_count integer,
  add column file_count integer;

update public.evidencelane_orders
set
  batch_id = id::text,
  offer_code = 'evidencelane_pack_20',
  tier_code = 'single',
  case_count = 1,
  file_count = 0
where batch_id is null;

alter table public.evidencelane_orders
  alter column batch_id set not null,
  alter column tier_code set not null,
  alter column case_count set not null,
  alter column file_count set not null,
  add constraint evidencelane_orders_batch_id_check
    check (
      batch_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  add constraint evidencelane_orders_tier_check
    check (
      (tier_code = 'single' and offer_code = 'evidencelane_pack_20' and case_count <= 1 and file_count <= 20) or
      (tier_code = 'multi' and offer_code = 'evidencelane_pack_50' and case_count <= 3 and file_count <= 50) or
      (tier_code = 'volume' and offer_code = 'evidencelane_pack_100' and case_count <= 10 and file_count <= 100)
    ),
  add constraint evidencelane_orders_case_count_check
    check (case_count between 1 and 10),
  add constraint evidencelane_orders_file_count_check
    check (file_count between 0 and 100);

create index evidencelane_orders_batch_id_idx
  on public.evidencelane_orders (batch_id);

comment on column public.evidencelane_orders.batch_id is
  'Opaque browser-local batch identifier bound to the Stripe entitlement.';

comment on column public.evidencelane_orders.tier_code is
  'Purchased EvidenceLane tier: single, multi, or volume.';
