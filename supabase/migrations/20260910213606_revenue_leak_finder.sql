create table if not exists public.revenue_leak_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  report_credits integer not null default 0 check (report_credits >= 0),
  free_reports_remaining integer not null default 1 check (free_reports_remaining between 0 and 1),
  reports_completed integer not null default 0 check (reports_completed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.revenue_leak_analyses (
  id uuid primary key default gen_random_uuid(),
  analysis_key text not null,
  user_id uuid not null references public.revenue_leak_accounts(user_id) on delete cascade,
  left_name text not null check (char_length(left_name) between 1 and 180),
  right_name text not null check (char_length(right_name) between 1 and 180),
  left_rows integer not null check (left_rows between 1 and 25000),
  right_rows integer not null check (right_rows between 1 and 25000),
  issue_count integer not null check (issue_count between 0 and 100000),
  value_at_risk_cents bigint not null check (value_at_risk_cents >= 0),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, analysis_key)
);

create table if not exists public.revenue_leak_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.revenue_leak_accounts(user_id) on delete cascade,
  event_type text not null check (event_type in ('analysis', 'purchase', 'adjustment', 'refund')),
  credit_delta integer not null,
  analysis_key text,
  stripe_event_id text,
  stripe_checkout_id text,
  stripe_payment_intent_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists revenue_leak_ledger_stripe_event_idx
  on public.revenue_leak_credit_ledger(stripe_event_id)
  where stripe_event_id is not null;

create index if not exists revenue_leak_analyses_user_created_idx
  on public.revenue_leak_analyses(user_id, created_at desc);

alter table public.revenue_leak_accounts enable row level security;
alter table public.revenue_leak_analyses enable row level security;
alter table public.revenue_leak_credit_ledger enable row level security;

revoke all on table public.revenue_leak_accounts from public, anon, authenticated;
revoke all on table public.revenue_leak_analyses from public, anon, authenticated;
revoke all on table public.revenue_leak_credit_ledger from public, anon, authenticated;
grant select, insert, update on table public.revenue_leak_accounts to service_role;
grant select, insert on table public.revenue_leak_analyses to service_role;
grant select, insert on table public.revenue_leak_credit_ledger to service_role;

create or replace function public.revenue_leak_record_analysis(
  p_user_id uuid,
  p_analysis_key text,
  p_left_name text,
  p_right_name text,
  p_left_rows integer,
  p_right_rows integer,
  p_issue_count integer,
  p_value_at_risk_cents bigint,
  p_summary jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_account public.revenue_leak_accounts%rowtype;
  v_used text;
begin
  if p_analysis_key !~ '^[a-zA-Z0-9_-]{12,80}$'
     or char_length(p_left_name) not between 1 and 180
     or char_length(p_right_name) not between 1 and 180
     or p_left_rows not between 1 and 25000
     or p_right_rows not between 1 and 25000
     or p_issue_count not between 0 and 100000
     or p_value_at_risk_cents < 0
     or pg_column_size(coalesce(p_summary, '{}'::jsonb)) > 8192 then
    raise exception 'invalid_revenue_leak_analysis';
  end if;

  select * into v_account
  from public.revenue_leak_accounts
  where user_id = p_user_id
  for update;
  if not found then raise exception 'revenue_leak_account_not_found'; end if;

  if exists (
    select 1 from public.revenue_leak_analyses
    where user_id = p_user_id and analysis_key = p_analysis_key
  ) then
    v_used := 'existing';
  elsif v_account.free_reports_remaining > 0 then
    update public.revenue_leak_accounts
    set free_reports_remaining = free_reports_remaining - 1,
        reports_completed = reports_completed + 1,
        updated_at = now()
    where user_id = p_user_id
    returning * into v_account;
    v_used := 'free';
  elsif v_account.report_credits > 0 then
    update public.revenue_leak_accounts
    set report_credits = report_credits - 1,
        reports_completed = reports_completed + 1,
        updated_at = now()
    where user_id = p_user_id
    returning * into v_account;
    v_used := 'credit';
  else
    return jsonb_build_object(
      'allowed', false,
      'account', jsonb_build_object(
        'email', v_account.email,
        'reportCredits', v_account.report_credits,
        'freeReportsRemaining', v_account.free_reports_remaining,
        'reportsCompleted', v_account.reports_completed
      )
    );
  end if;

  if v_used <> 'existing' then
    insert into public.revenue_leak_analyses (
      analysis_key, user_id, left_name, right_name, left_rows, right_rows,
      issue_count, value_at_risk_cents, summary
    ) values (
      p_analysis_key, p_user_id, p_left_name, p_right_name, p_left_rows, p_right_rows,
      p_issue_count, p_value_at_risk_cents, coalesce(p_summary, '{}'::jsonb)
    );
    insert into public.revenue_leak_credit_ledger (user_id, event_type, credit_delta, analysis_key, metadata)
    values (p_user_id, 'analysis', case when v_used = 'credit' then -1 else 0 end, p_analysis_key,
      jsonb_build_object('used', v_used, 'issueCount', p_issue_count));
  end if;

  return jsonb_build_object(
    'allowed', true,
    'used', v_used,
    'account', jsonb_build_object(
      'email', v_account.email,
      'reportCredits', v_account.report_credits,
      'freeReportsRemaining', v_account.free_reports_remaining,
      'reportsCompleted', v_account.reports_completed
    )
  );
end;
$$;

create or replace function public.revenue_leak_fulfill_purchase(
  p_event_id text,
  p_checkout_id text,
  p_payment_intent_id text,
  p_user_id uuid,
  p_currency text,
  p_amount_subtotal integer,
  p_amount_total integer,
  p_credits integer,
  p_livemode boolean
) returns jsonb
language plpgsql
as $$
declare
  v_account public.revenue_leak_accounts%rowtype;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9_]+'
     or p_checkout_id !~ '^cs_[A-Za-z0-9_]+'
     or p_currency <> 'usd'
     or p_amount_subtotal <> 2900
     or p_amount_total < p_amount_subtotal
     or p_amount_total > 10000
     or p_credits <> 10 then
    raise exception 'invalid_revenue_leak_purchase';
  end if;

  select * into v_account
  from public.revenue_leak_accounts
  where user_id = p_user_id
  for update;
  if not found then raise exception 'revenue_leak_account_not_found'; end if;

  if exists (select 1 from public.revenue_leak_credit_ledger where stripe_event_id = p_event_id) then
    return jsonb_build_object('alreadyRecorded', true, 'credits', v_account.report_credits);
  end if;

  insert into public.revenue_leak_credit_ledger (
    user_id, event_type, credit_delta, stripe_event_id, stripe_checkout_id,
    stripe_payment_intent_id, metadata
  ) values (
    p_user_id, 'purchase', p_credits, p_event_id, p_checkout_id,
    nullif(p_payment_intent_id, ''),
    jsonb_build_object('currency', p_currency, 'amountSubtotal', p_amount_subtotal,
      'amountTotal', p_amount_total, 'livemode', p_livemode)
  );
  update public.revenue_leak_accounts
  set report_credits = report_credits + p_credits, updated_at = now()
  where user_id = p_user_id
  returning * into v_account;
  return jsonb_build_object('alreadyRecorded', false, 'credits', v_account.report_credits);
end;
$$;

revoke all on function public.revenue_leak_record_analysis(uuid, text, text, text, integer, integer, integer, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.revenue_leak_fulfill_purchase(text, text, text, uuid, text, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.revenue_leak_record_analysis(uuid, text, text, text, integer, integer, integer, bigint, jsonb) to service_role;
grant execute on function public.revenue_leak_fulfill_purchase(text, text, text, uuid, text, integer, integer, integer, boolean) to service_role;

comment on table public.revenue_leak_analyses is
  'Aggregate reconciliation history only. Raw CSV rows and customer PII are never stored.';
