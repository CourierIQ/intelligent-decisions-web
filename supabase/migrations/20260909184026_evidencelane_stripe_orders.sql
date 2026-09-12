create table public.evidencelane_orders (
  id uuid primary key default gen_random_uuid(),
  order_reference text not null unique
    check (char_length(order_reference) between 4 and 80),
  offer_code text not null
    check (offer_code = 'evidencelane_single_pack'),
  stripe_checkout_session_id text not null unique
    check (char_length(stripe_checkout_session_id) between 8 and 255),
  stripe_payment_intent_id text,
  stripe_customer_id text,
  customer_email text
    check (
      customer_email is null or
      customer_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    ),
  amount_total bigint
    check (amount_total is null or amount_total >= 0),
  amount_tax bigint
    check (amount_tax is null or amount_tax >= 0),
  currency text
    check (currency is null or currency ~ '^[a-z]{3}$'),
  payment_status text not null default 'unknown'
    check (payment_status in ('paid', 'unpaid', 'no_payment_required', 'unknown')),
  checkout_status text not null default 'unknown'
    check (checkout_status in ('open', 'complete', 'expired', 'unknown')),
  last_event_type text not null,
  livemode boolean not null default false,
  paid_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index evidencelane_orders_created_at_idx
  on public.evidencelane_orders (created_at desc);

alter table public.evidencelane_orders enable row level security;
revoke all on table public.evidencelane_orders from anon, authenticated;

comment on table public.evidencelane_orders is
  'Server-only EvidenceLane orders confirmed by signed Stripe webhook events.';

create table public.stripe_webhook_events (
  event_id text primary key
    check (char_length(event_id) between 8 and 255),
  event_type text not null
    check (char_length(event_type) between 3 and 100),
  object_id text,
  livemode boolean not null default false,
  processed_at timestamp with time zone not null default now()
);

create index stripe_webhook_events_processed_at_idx
  on public.stripe_webhook_events (processed_at desc);

alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from anon, authenticated;

comment on table public.stripe_webhook_events is
  'Server-only Stripe event IDs used to make webhook processing idempotent.';
