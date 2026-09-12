create table public.bidlens_accounts (
    user_id uuid primary key references auth.users(id) on delete cascade,
    email text not null check (char_length(email) between 3 and 320),
    credit_balance integer not null default 2 check (credit_balance >= 0),
    lifetime_credits integer not null default 2 check (lifetime_credits >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.bidlens_analyses (
    id uuid primary key default gen_random_uuid(),
    request_id text not null unique check (char_length(request_id) between 8 and 80),
    user_id uuid not null references public.bidlens_accounts(user_id) on delete cascade,
    title text not null check (char_length(title) between 1 and 160),
    source_type text not null check (source_type in ('file', 'text')),
    source_filename text check (source_filename is null or char_length(source_filename) between 1 and 180),
    source_size integer not null check (source_size between 1 and 8388608),
    score integer not null check (score between 0 and 100),
    recommendation text not null check (recommendation in ('bid', 'conditional_bid', 'no_bid')),
    result jsonb not null check (jsonb_typeof(result) = 'object'),
    model text not null check (char_length(model) between 1 and 100),
    created_at timestamptz not null default now(),
    check ((source_type = 'file' and source_filename is not null) or (source_type = 'text' and source_filename is null))
);

create index bidlens_analyses_user_created_idx
on public.bidlens_analyses (user_id, created_at desc);

create table public.bidlens_credit_ledger (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.bidlens_accounts(user_id) on delete cascade,
    event_type text not null check (event_type in ('welcome', 'analysis', 'analysis_refund', 'purchase', 'adjustment')),
    credit_delta integer not null check (credit_delta <> 0),
    reference_id text not null check (char_length(reference_id) between 1 and 255),
    metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz not null default now(),
    unique (user_id, event_type, reference_id)
);

create index bidlens_credit_ledger_user_created_idx
on public.bidlens_credit_ledger (user_id, created_at desc);

create table public.bidlens_payment_events (
    provider_event_id text primary key check (char_length(provider_event_id) between 4 and 255),
    provider_checkout_id text not null unique check (char_length(provider_checkout_id) between 4 and 255),
    user_id uuid not null references public.bidlens_accounts(user_id) on delete restrict,
    sku text not null check (sku in ('analyses_10', 'analyses_30')),
    credits integer not null check (credits in (10, 30)),
    currency text not null check (currency ~ '^[a-z]{3}$'),
    amount_subtotal integer not null check (amount_subtotal > 0),
    amount_total integer not null check (amount_total >= amount_subtotal),
    livemode boolean not null,
    created_at timestamptz not null default now()
);

alter table public.bidlens_accounts enable row level security;
alter table public.bidlens_analyses enable row level security;
alter table public.bidlens_credit_ledger enable row level security;
alter table public.bidlens_payment_events enable row level security;

revoke all on table public.bidlens_accounts from public, anon, authenticated;
revoke all on table public.bidlens_analyses from public, anon, authenticated;
revoke all on table public.bidlens_credit_ledger from public, anon, authenticated;
revoke all on table public.bidlens_payment_events from public, anon, authenticated;

grant select, insert, update, delete on table public.bidlens_accounts to service_role;
grant select, insert, update, delete on table public.bidlens_analyses to service_role;
grant select, insert, update, delete on table public.bidlens_credit_ledger to service_role;
grant select, insert, update, delete on table public.bidlens_payment_events to service_role;

create or replace function public.bidlens_ensure_account(
    p_user_id uuid,
    p_email text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    account public.bidlens_accounts%rowtype;
begin
    if p_user_id is null or char_length(btrim(coalesce(p_email, ''))) not between 3 and 320 then
        raise exception using errcode = '22023', message = 'invalid_bidlens_identity';
    end if;

    insert into public.bidlens_accounts (user_id, email)
    values (p_user_id, lower(btrim(p_email)))
    on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now()
    returning * into account;

    insert into public.bidlens_credit_ledger (
        user_id, event_type, credit_delta, reference_id, metadata
    ) values (
        p_user_id, 'welcome', 2, 'welcome', jsonb_build_object('source', 'mvp_launch')
    ) on conflict (user_id, event_type, reference_id) do nothing;

    return jsonb_build_object(
        'userId', account.user_id,
        'email', account.email,
        'creditBalance', account.credit_balance,
        'lifetimeCredits', account.lifetime_credits,
        'createdAt', account.created_at,
        'updatedAt', account.updated_at
    );
end;
$$;

create or replace function public.bidlens_reserve_analysis(
    p_user_id uuid,
    p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    account public.bidlens_accounts%rowtype;
begin
    if char_length(btrim(coalesce(p_request_id, ''))) not between 8 and 80 then
        raise exception using errcode = '22023', message = 'invalid_bidlens_request';
    end if;

    if exists (
        select 1 from public.bidlens_credit_ledger
        where user_id = p_user_id
          and event_type = 'analysis'
          and reference_id = p_request_id
    ) then
        select * into account from public.bidlens_accounts where user_id = p_user_id;
        return jsonb_build_object('reserved', true, 'creditBalance', account.credit_balance);
    end if;

    select * into account
    from public.bidlens_accounts
    where user_id = p_user_id
    for update;

    if account.user_id is null then
        raise exception using errcode = 'P0002', message = 'bidlens_account_not_found';
    end if;
    if account.credit_balance < 1 then
        raise exception using errcode = 'P0001', message = 'bidlens_insufficient_credits';
    end if;

    update public.bidlens_accounts
    set credit_balance = credit_balance - 1,
        updated_at = now()
    where user_id = p_user_id
    returning * into account;

    insert into public.bidlens_credit_ledger (
        user_id, event_type, credit_delta, reference_id
    ) values (p_user_id, 'analysis', -1, p_request_id);

    return jsonb_build_object('reserved', true, 'creditBalance', account.credit_balance);
end;
$$;

create or replace function public.bidlens_release_analysis(
    p_user_id uuid,
    p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    account public.bidlens_accounts%rowtype;
begin
    select * into account
    from public.bidlens_accounts
    where user_id = p_user_id
    for update;

    if account.user_id is null then
        raise exception using errcode = 'P0002', message = 'bidlens_account_not_found';
    end if;

    if exists (
        select 1 from public.bidlens_credit_ledger
        where user_id = p_user_id
          and event_type = 'analysis'
          and reference_id = p_request_id
    ) and not exists (
        select 1 from public.bidlens_analyses
        where user_id = p_user_id and request_id = p_request_id
    ) then
        insert into public.bidlens_credit_ledger (
            user_id, event_type, credit_delta, reference_id
        ) values (p_user_id, 'analysis_refund', 1, p_request_id)
        on conflict (user_id, event_type, reference_id) do nothing;

        if found then
            update public.bidlens_accounts
            set credit_balance = credit_balance + 1,
                updated_at = now()
            where user_id = p_user_id
            returning * into account;
        end if;
    end if;

    return jsonb_build_object('released', true, 'creditBalance', account.credit_balance);
end;
$$;

create or replace function public.bidlens_fulfill_purchase(
    p_event_id text,
    p_checkout_id text,
    p_user_id uuid,
    p_sku text,
    p_credits integer,
    p_currency text,
    p_amount_subtotal integer,
    p_amount_total integer,
    p_livemode boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    account public.bidlens_accounts%rowtype;
begin
    if char_length(btrim(coalesce(p_event_id, ''))) not between 4 and 255
       or char_length(btrim(coalesce(p_checkout_id, ''))) not between 4 and 255
       or (p_sku, p_credits) not in (('analyses_10', 10), ('analyses_30', 30))
       or p_currency !~ '^[a-z]{3}$'
       or p_amount_subtotal <> (case p_sku when 'analyses_10' then 2900 when 'analyses_30' then 6900 else -1 end)
       or p_amount_total < p_amount_subtotal
       or p_amount_total > p_amount_subtotal + 5000 then
        raise exception using errcode = '22023', message = 'invalid_bidlens_purchase';
    end if;

    select * into account
    from public.bidlens_accounts
    where user_id = p_user_id
    for update;

    if account.user_id is null then
        raise exception using errcode = 'P0002', message = 'bidlens_account_not_found';
    end if;

    insert into public.bidlens_payment_events (
        provider_event_id, provider_checkout_id, user_id, sku, credits,
        currency, amount_subtotal, amount_total, livemode
    ) values (
        btrim(p_event_id), btrim(p_checkout_id), p_user_id, p_sku, p_credits,
        lower(p_currency), p_amount_subtotal, p_amount_total, p_livemode
    ) on conflict do nothing;

    if found then
        update public.bidlens_accounts
        set credit_balance = credit_balance + p_credits,
            lifetime_credits = lifetime_credits + p_credits,
            updated_at = now()
        where user_id = p_user_id
        returning * into account;

        insert into public.bidlens_credit_ledger (
            user_id, event_type, credit_delta, reference_id, metadata
        ) values (
            p_user_id,
            'purchase',
            p_credits,
            btrim(p_checkout_id),
            jsonb_build_object('sku', p_sku, 'eventId', p_event_id)
        );
    end if;

    return jsonb_build_object(
        'fulfilled', true,
        'creditBalance', account.credit_balance
    );
end;
$$;

revoke all on function public.bidlens_ensure_account(uuid, text) from public, anon, authenticated;
revoke all on function public.bidlens_reserve_analysis(uuid, text) from public, anon, authenticated;
revoke all on function public.bidlens_release_analysis(uuid, text) from public, anon, authenticated;
revoke all on function public.bidlens_fulfill_purchase(text, text, uuid, text, integer, text, integer, integer, boolean) from public, anon, authenticated;

grant execute on function public.bidlens_ensure_account(uuid, text) to service_role;
grant execute on function public.bidlens_reserve_analysis(uuid, text) to service_role;
grant execute on function public.bidlens_release_analysis(uuid, text) to service_role;
grant execute on function public.bidlens_fulfill_purchase(text, text, uuid, text, integer, text, integer, integer, boolean) to service_role;

comment on table public.bidlens_analyses is
'Stores structured BidLens reports only. Original RFP files and pasted source text are never persisted.';
