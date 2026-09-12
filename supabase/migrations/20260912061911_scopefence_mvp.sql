create table public.scopefence_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  free_analyses_used integer not null default 0 check (free_analyses_used between 0 and 3),
  paid_credit_balance integer not null default 0 check (paid_credit_balance >= 0),
  access_status text not null default 'active' check (access_status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.scopefence_scopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.scopefence_accounts(user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  content text not null check (char_length(content) between 120 and 30000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scopefence_scopes_user_updated_idx on public.scopefence_scopes(user_id, updated_at desc);

create table public.scopefence_analyses (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique check (char_length(request_id) between 8 and 80),
  user_id uuid not null references public.scopefence_accounts(user_id) on delete cascade,
  scope_id uuid references public.scopefence_scopes(id) on delete set null,
  scope_title text not null check (char_length(scope_title) between 1 and 120),
  scope_text text not null check (char_length(scope_text) between 120 and 30000),
  client_request text not null check (char_length(client_request) between 20 and 8000),
  hourly_rate_cents integer not null check (hourly_rate_cents between 2500 and 100000),
  credit_source text not null check (credit_source in ('free', 'paid')),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now()
);

create index scopefence_analyses_user_created_idx on public.scopefence_analyses(user_id, created_at desc);
create index scopefence_analyses_scope_id_idx on public.scopefence_analyses(scope_id) where scope_id is not null;

create table public.scopefence_analysis_reservations (
  request_id text primary key check (char_length(request_id) between 8 and 80),
  user_id uuid not null references public.scopefence_accounts(user_id) on delete cascade,
  credit_source text not null check (credit_source in ('free', 'paid')),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'refunded')),
  analysis_id uuid unique references public.scopefence_analyses(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scopefence_reservations_user_created_idx on public.scopefence_analysis_reservations(user_id, created_at desc);

create table public.scopefence_credit_orders (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique check (char_length(event_id) between 4 and 255),
  payment_intent_id text not null unique check (char_length(payment_intent_id) between 4 and 255),
  user_id uuid not null references public.scopefence_accounts(user_id) on delete restrict,
  sku text not null check (sku = 'analyses_20'),
  credits integer not null check (credits = 20),
  amount_total integer not null check (amount_total = 2900),
  amount_tax integer not null check (amount_tax between 0 and amount_total),
  currency text not null check (currency = 'usd'),
  live_mode boolean not null,
  created_at timestamptz not null default now()
);

alter table public.scopefence_accounts enable row level security;
alter table public.scopefence_scopes enable row level security;
alter table public.scopefence_analyses enable row level security;
alter table public.scopefence_analysis_reservations enable row level security;
alter table public.scopefence_credit_orders enable row level security;

revoke all on table public.scopefence_accounts from public, anon, authenticated;
revoke all on table public.scopefence_scopes from public, anon, authenticated;
revoke all on table public.scopefence_analyses from public, anon, authenticated;
revoke all on table public.scopefence_analysis_reservations from public, anon, authenticated;
revoke all on table public.scopefence_credit_orders from public, anon, authenticated;

grant select, insert, update, delete on table public.scopefence_accounts to service_role;
grant select, insert, update, delete on table public.scopefence_scopes to service_role;
grant select, insert, update, delete on table public.scopefence_analyses to service_role;
grant select, insert, update, delete on table public.scopefence_analysis_reservations to service_role;
grant select, insert, update, delete on table public.scopefence_credit_orders to service_role;

create or replace function public.scopefence_reserve_analysis(p_user_id uuid, p_request_id text)
returns table (credit_source text, reservation_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  account public.scopefence_accounts%rowtype;
  reservation public.scopefence_analysis_reservations%rowtype;
  selected_source text;
begin
  if p_user_id is null or char_length(btrim(coalesce(p_request_id, ''))) not between 8 and 80 then
    raise exception using errcode = '22023', message = 'invalid_scopefence_request';
  end if;

  select * into account from public.scopefence_accounts where user_id = p_user_id for update;
  if account.user_id is null then raise exception 'scopefence_account_not_found'; end if;
  if account.access_status <> 'active' then raise exception 'scopefence_account_suspended'; end if;

  select * into reservation from public.scopefence_analysis_reservations where request_id = btrim(p_request_id) for update;
  if reservation.request_id is not null and reservation.user_id <> p_user_id then
    raise exception 'scopefence_request_owner_mismatch';
  end if;
  if reservation.status in ('reserved', 'committed') then
    return query select reservation.credit_source, reservation.status;
    return;
  end if;

  if account.free_analyses_used < 3 then
    update public.scopefence_accounts set free_analyses_used = free_analyses_used + 1, updated_at = now() where user_id = p_user_id;
    selected_source := 'free';
  elsif account.paid_credit_balance > 0 then
    update public.scopefence_accounts set paid_credit_balance = paid_credit_balance - 1, updated_at = now() where user_id = p_user_id;
    selected_source := 'paid';
  else
    raise exception 'scopefence_credit_required';
  end if;

  insert into public.scopefence_analysis_reservations(request_id, user_id, credit_source, status)
  values (btrim(p_request_id), p_user_id, selected_source, 'reserved')
  on conflict (request_id) do update set credit_source = excluded.credit_source, status = 'reserved', analysis_id = null, updated_at = now();

  return query select selected_source, 'reserved'::text;
end;
$$;

create or replace function public.scopefence_refund_analysis(p_user_id uuid, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.scopefence_analysis_reservations%rowtype;
begin
  select * into reservation from public.scopefence_analysis_reservations
  where request_id = btrim(p_request_id) and user_id = p_user_id for update;
  if reservation.request_id is null then return jsonb_build_object('refunded', false, 'status', 'missing'); end if;
  if reservation.status <> 'reserved' then return jsonb_build_object('refunded', false, 'status', reservation.status); end if;

  if reservation.credit_source = 'free' then
    update public.scopefence_accounts set free_analyses_used = greatest(0, free_analyses_used - 1), updated_at = now() where user_id = p_user_id;
  else
    update public.scopefence_accounts set paid_credit_balance = paid_credit_balance + 1, updated_at = now() where user_id = p_user_id;
  end if;
  update public.scopefence_analysis_reservations set status = 'refunded', updated_at = now() where request_id = reservation.request_id;
  return jsonb_build_object('refunded', true, 'status', 'refunded');
end;
$$;

create or replace function public.scopefence_record_analysis(
  p_user_id uuid,
  p_request_id text,
  p_scope_id uuid,
  p_scope_title text,
  p_scope_text text,
  p_client_request text,
  p_hourly_rate_cents integer,
  p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.scopefence_analysis_reservations%rowtype;
  analysis public.scopefence_analyses%rowtype;
begin
  select * into reservation from public.scopefence_analysis_reservations
  where request_id = btrim(p_request_id) and user_id = p_user_id for update;
  if reservation.request_id is null or reservation.status = 'refunded' then raise exception 'scopefence_reservation_required'; end if;

  insert into public.scopefence_analyses(
    request_id, user_id, scope_id, scope_title, scope_text, client_request,
    hourly_rate_cents, credit_source, result
  ) values (
    btrim(p_request_id), p_user_id, p_scope_id, p_scope_title, p_scope_text, p_client_request,
    p_hourly_rate_cents, reservation.credit_source, p_result
  ) on conflict (request_id) do nothing
  returning * into analysis;

  if analysis.id is null then
    select * into analysis from public.scopefence_analyses where request_id = btrim(p_request_id) and user_id = p_user_id;
  end if;
  if analysis.id is null then raise exception 'scopefence_analysis_owner_mismatch'; end if;

  update public.scopefence_analysis_reservations
  set status = 'committed', analysis_id = analysis.id, updated_at = now()
  where request_id = reservation.request_id;

  return to_jsonb(analysis);
end;
$$;

create or replace function public.scopefence_fulfill_credit_purchase(
  p_event_id text,
  p_payment_intent_id text,
  p_user_id uuid,
  p_email text,
  p_sku text,
  p_credits integer,
  p_amount_total integer,
  p_amount_tax integer,
  p_currency text,
  p_live_mode boolean
) returns table (credited boolean, paid_credit_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  balance integer;
begin
  if p_user_id is null or p_sku <> 'analyses_20' or p_credits <> 20 or p_amount_total <> 2900 or
     p_amount_tax < 0 or p_amount_tax > p_amount_total or p_currency <> 'usd' then
    raise exception 'invalid_scopefence_purchase';
  end if;

  insert into public.scopefence_accounts(user_id, email)
  values (p_user_id, lower(btrim(p_email)))
  on conflict (user_id) do update set email = excluded.email, updated_at = now();

  insert into public.scopefence_credit_orders(event_id, payment_intent_id, user_id, sku, credits, amount_total, amount_tax, currency, live_mode)
  values (btrim(p_event_id), btrim(p_payment_intent_id), p_user_id, p_sku, p_credits, p_amount_total, p_amount_tax, p_currency, p_live_mode)
  on conflict do nothing;

  if found then
    update public.scopefence_accounts set paid_credit_balance = scopefence_accounts.paid_credit_balance + p_credits, updated_at = now()
    where user_id = p_user_id returning scopefence_accounts.paid_credit_balance into balance;
    return query select true, balance;
  end if;

  select a.paid_credit_balance into balance from public.scopefence_accounts a where a.user_id = p_user_id;
  return query select false, balance;
end;
$$;

revoke all on function public.scopefence_reserve_analysis(uuid, text) from public, anon, authenticated;
revoke all on function public.scopefence_refund_analysis(uuid, text) from public, anon, authenticated;
revoke all on function public.scopefence_record_analysis(uuid, text, uuid, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.scopefence_fulfill_credit_purchase(text, text, uuid, text, text, integer, integer, integer, text, boolean) from public, anon, authenticated;

grant execute on function public.scopefence_reserve_analysis(uuid, text) to service_role;
grant execute on function public.scopefence_refund_analysis(uuid, text) to service_role;
grant execute on function public.scopefence_record_analysis(uuid, text, uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.scopefence_fulfill_credit_purchase(text, text, uuid, text, text, integer, integer, integer, text, boolean) to service_role;

comment on table public.scopefence_analysis_reservations is 'Idempotent ScopeFence analysis credit reservations keyed by client request ID.';
