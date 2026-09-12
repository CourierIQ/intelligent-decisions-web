-- Legacy schema baseline.
--
-- CourierIQ and the beta-intake workflow existed before migration tracking was
-- enabled. These idempotent definitions capture their production schema so a
-- fresh environment can apply the repository migrations from the beginning.
-- Existing production tables are left untouched when this migration is
-- reconciled with remote history.

create table if not exists public.courieriq_users (
    id text not null,
    driver_first_name text,
    driver_email text,
    business_name text,
    created_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    auth_account_id text,
    auth_provider text,
    auth_email text,
    constraint courieriq_users_pkey primary key (id)
);

create table if not exists public.courieriq_sessions (
    id text not null,
    user_id text not null,
    started_at bigint not null,
    ended_at bigint,
    is_active boolean default false not null,
    accumulated_dead_time_ms bigint default 0 not null,
    active_dead_time_started_at bigint,
    elapsed_seconds bigint default 0 not null,
    dead_seconds bigint default 0 not null,
    created_by_client_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    constraint courieriq_sessions_pkey primary key (id),
    constraint courieriq_sessions_user_id_fkey
        foreign key (user_id) references public.courieriq_users (id) on delete cascade
);

create table if not exists public.courieriq_trips (
    id text not null,
    user_id text not null,
    started_at bigint not null,
    completed_at bigint not null,
    drive_to_restaurant_seconds bigint default 0 not null,
    restaurant_wait_seconds bigint default 0 not null,
    drive_to_customer_seconds bigint default 0 not null,
    total_trip_seconds bigint default 0 not null,
    offer_count integer default 0 not null,
    completed_offer_count integer default 0 not null,
    canceled_offer_count integer default 0 not null,
    total_offer_pay numeric,
    total_offer_miles numeric,
    total_offer_estimated_minutes numeric,
    average_offer_iq_score integer,
    created_by_client_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    session_id text,
    constraint courieriq_trips_pkey primary key (id),
    constraint courieriq_trips_user_id_fkey
        foreign key (user_id) references public.courieriq_users (id) on delete cascade
);

create table if not exists public.courieriq_offers (
    id text not null,
    trip_id text not null,
    user_id text not null,
    client_offer_id text not null,
    base_pay numeric default 0 not null,
    quest_value numeric default 0 not null,
    total_pay numeric default 0 not null,
    miles numeric default 0 not null,
    tracked_miles numeric,
    stat_miles numeric default 0 not null,
    estimated_minutes numeric default 0 not null,
    iq_score integer default 0 not null,
    iq_rating text default ''::text not null,
    accepted_at bigint not null,
    arrived_at bigint,
    picked_up_at bigint,
    delivered_at bigint,
    canceled_at bigint,
    restaurant_name text default ''::text not null,
    pickup_address text default ''::text not null,
    dropoff_address text default ''::text not null,
    pickup_latitude numeric,
    pickup_longitude numeric,
    dropoff_latitude numeric,
    dropoff_longitude numeric,
    status text not null,
    completed boolean default false not null,
    canceled boolean default false not null,
    active_seconds bigint,
    drive_to_restaurant_seconds bigint,
    restaurant_wait_seconds bigint,
    delivery_seconds bigint,
    created_by_client_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    session_id text,
    accept_address text default ''::text not null,
    accept_latitude numeric,
    accept_longitude numeric,
    accept_to_pickup_miles numeric,
    generated_iq_score integer,
    generated_iq_rating text default ''::text not null,
    constraint courieriq_offers_pkey primary key (id),
    constraint courieriq_offers_trip_id_client_offer_id_key unique (trip_id, client_offer_id),
    constraint courieriq_offers_trip_id_fkey
        foreign key (trip_id) references public.courieriq_trips (id) on delete cascade,
    constraint courieriq_offers_user_id_fkey
        foreign key (user_id) references public.courieriq_users (id) on delete cascade
);

create table if not exists public.courieriq_offer_score_components (
    id text not null,
    offer_id text not null,
    user_id text not null,
    title text not null,
    score integer default 0 not null,
    weight numeric default 0 not null,
    actual_value text default ''::text not null,
    status text default ''::text not null,
    explanation text default ''::text not null,
    created_by_client_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    constraint courieriq_offer_score_components_pkey primary key (id),
    constraint courieriq_offer_score_components_offer_id_fkey
        foreign key (offer_id) references public.courieriq_offers (id) on delete cascade,
    constraint courieriq_offer_score_components_user_id_fkey
        foreign key (user_id) references public.courieriq_users (id) on delete cascade
);

create table if not exists public.courieriq_sync_batches (
    id uuid not null,
    app_name text not null,
    app_version_name text not null,
    app_version_code integer not null,
    release_label text not null,
    sync_protocol_version integer not null,
    client_sent_at bigint not null,
    accepted_records integer default 0 not null,
    created_at timestamp with time zone default now() not null,
    constraint courieriq_sync_batches_pkey primary key (id)
);

create table if not exists public.courieriq_sync_records (
    id text not null,
    batch_id uuid not null,
    payload_type text not null,
    record_id text not null,
    user_id text,
    attempt_count integer default 0 not null,
    accepted_at timestamp with time zone default now() not null,
    constraint courieriq_sync_records_pkey primary key (id),
    constraint courieriq_sync_records_batch_id_fkey
        foreign key (batch_id) references public.courieriq_sync_batches (id) on delete cascade
);

create table if not exists public.courieriq_auth_accounts (
    id text not null,
    provider text not null,
    provider_subject text not null,
    email text not null,
    display_name text,
    picture_url text,
    last_local_user_id text,
    last_session_token text,
    last_signed_in_at timestamp with time zone,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    is_pro boolean default false not null,
    pro_updated_at timestamp with time zone,
    pro_source text default 'manual'::text not null,
    constraint courieriq_auth_accounts_pkey primary key (id),
    constraint courieriq_auth_accounts_provider_provider_subject_key
        unique (provider, provider_subject)
);

create table if not exists public.courieriq_oauth_states (
    state_id text not null,
    local_user_id text,
    return_uri text default 'courieriq://auth/callback'::text not null,
    auth_attempt_id text,
    issued_at_ms bigint not null,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone default now() not null,
    constraint courieriq_oauth_states_pkey primary key (state_id)
);

create table if not exists public.courieriq_active_trips (
    id text not null,
    user_id text not null,
    session_id text,
    phase text default 'NOT_STARTED'::text not null,
    trip_start_time bigint,
    is_active boolean default false not null,
    active_offers jsonb default '[]'::jsonb not null,
    active_offer_count integer default 0 not null,
    created_by_client_at bigint not null,
    updated_at bigint not null,
    server_created_at timestamp with time zone default now() not null,
    server_updated_at timestamp with time zone default now() not null,
    constraint courieriq_active_trips_pkey primary key (id),
    constraint courieriq_active_trips_user_id_fkey
        foreign key (user_id) references public.courieriq_users (id) on delete cascade
);

create table if not exists public.courieriq_auth_email_identities (
    normalized_email text not null,
    auth_account_id text,
    canonical_user_id text not null,
    first_local_user_id text,
    last_local_user_id text,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint courieriq_auth_email_identities_pkey primary key (normalized_email)
);

create table if not exists public.courieriq_payment_purchases (
    id text not null,
    auth_account_id text not null,
    canonical_user_id text,
    email text,
    platform text not null,
    product_id text not null,
    purchase_type text not null,
    purchase_token text not null,
    order_id text,
    status text not null,
    verified boolean default false not null,
    is_entitled boolean default false not null,
    raw_payload jsonb,
    raw_verification jsonb,
    message text,
    verified_at timestamp with time zone,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint courieriq_payment_purchases_pkey primary key (id),
    constraint courieriq_payment_purchases_purchase_token_key unique (purchase_token)
);

create table if not exists public.beta_access_requests (
    id uuid default gen_random_uuid() not null,
    first_name text not null,
    email text not null,
    email_normalized text generated always as (lower(btrim(email))) stored,
    state text,
    android_device text not null,
    delivery_platforms text[] default '{}'::text[] not null,
    weekly_deliveries text not null,
    interest_reason text,
    consent_at timestamp with time zone not null,
    status text default 'pending'::text not null,
    source text default 'idi_website'::text not null,
    admin_email_status text default 'pending'::text not null,
    applicant_email_status text default 'pending'::text not null,
    admin_resend_id text,
    applicant_resend_id text,
    last_email_error text,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    admin_notes text,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    invited_at timestamp with time zone,
    invite_resend_id text,
    invite_email_status text default 'not_sent'::text not null,
    invite_email_error text,
    constraint beta_access_requests_pkey primary key (id),
    constraint beta_access_email_unique unique (email_normalized),
    constraint beta_access_email_format
        check (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'::text),
    constraint beta_access_invite_email_status_check
        check (invite_email_status = any (array['not_sent'::text, 'pending'::text, 'sent'::text, 'failed'::text])),
    constraint beta_access_requests_admin_email_status_check
        check (admin_email_status = any (array['pending'::text, 'sent'::text, 'failed'::text])),
    constraint beta_access_requests_android_device_check
        check (char_length(android_device) >= 2 and char_length(android_device) <= 120),
    constraint beta_access_requests_applicant_email_status_check
        check (applicant_email_status = any (array['pending'::text, 'sent'::text, 'failed'::text])),
    constraint beta_access_requests_delivery_platforms_check
        check (cardinality(delivery_platforms) >= 1 and cardinality(delivery_platforms) <= 10),
    constraint beta_access_requests_first_name_check
        check (char_length(first_name) >= 1 and char_length(first_name) <= 80),
    constraint beta_access_requests_interest_reason_check
        check (interest_reason is null or char_length(interest_reason) <= 1000),
    constraint beta_access_requests_state_check
        check (state is null or char_length(state) >= 2 and char_length(state) <= 80),
    constraint beta_access_requests_status_check
        check (status = any (array['pending'::text, 'approved'::text, 'invited'::text, 'active'::text, 'declined'::text])),
    constraint beta_access_requests_weekly_deliveries_check
        check (weekly_deliveries = any (array['1-10'::text, '11-25'::text, '26-50'::text, '51-100'::text, '100+'::text]))
);

create table if not exists public.beta_access_request_events (
    id bigint generated by default as identity not null,
    request_id uuid not null,
    event_type text not null,
    actor_email text not null,
    previous_status text,
    new_status text,
    details jsonb default '{}'::jsonb not null,
    created_at timestamp with time zone default now() not null,
    constraint beta_access_request_events_pkey primary key (id),
    constraint beta_access_request_events_request_id_fkey
        foreign key (request_id) references public.beta_access_requests (id) on delete cascade,
    constraint beta_access_request_events_event_type_check
        check (event_type = any (array['created'::text, 'status_changed'::text, 'notes_updated'::text, 'invite_sent'::text, 'invite_failed'::text, 'email_retried'::text]))
);

create index if not exists idx_courieriq_users_auth_account
    on public.courieriq_users (auth_account_id);
create index if not exists idx_courieriq_users_auth_account_created
    on public.courieriq_users (auth_account_id, server_created_at)
    where auth_account_id is not null;
create index if not exists idx_courieriq_users_auth_email_lower
    on public.courieriq_users (lower(auth_email))
    where auth_email is not null;
create index if not exists idx_courieriq_users_driver_email_lower
    on public.courieriq_users (lower(driver_email))
    where driver_email is not null;
create index if not exists idx_courieriq_users_email
    on public.courieriq_users (driver_email);

create index if not exists idx_courieriq_sessions_user_started
    on public.courieriq_sessions (user_id, started_at);

create index if not exists idx_courieriq_trips_session
    on public.courieriq_trips (session_id)
    where session_id is not null;
create index if not exists idx_courieriq_trips_user_completed
    on public.courieriq_trips (user_id, completed_at);

create index if not exists idx_courieriq_offers_accept_location
    on public.courieriq_offers (user_id, accept_latitude, accept_longitude)
    where accept_latitude is not null and accept_longitude is not null;
create index if not exists idx_courieriq_offers_dropoff_location
    on public.courieriq_offers (user_id, dropoff_latitude, dropoff_longitude)
    where dropoff_latitude is not null and dropoff_longitude is not null;
create index if not exists idx_courieriq_offers_pickup_location
    on public.courieriq_offers (user_id, pickup_latitude, pickup_longitude)
    where pickup_latitude is not null and pickup_longitude is not null;
create index if not exists idx_courieriq_offers_session
    on public.courieriq_offers (session_id)
    where session_id is not null;
create index if not exists idx_courieriq_offers_trip
    on public.courieriq_offers (trip_id);
create index if not exists idx_courieriq_offers_user_accepted
    on public.courieriq_offers (user_id, accepted_at);

create index if not exists idx_courieriq_sync_records_batch
    on public.courieriq_sync_records (batch_id);

create index if not exists idx_courieriq_auth_accounts_email
    on public.courieriq_auth_accounts (email);
create index if not exists idx_courieriq_auth_accounts_is_pro
    on public.courieriq_auth_accounts (is_pro);

create index if not exists idx_courieriq_oauth_states_created_at
    on public.courieriq_oauth_states (created_at);
create index if not exists idx_courieriq_oauth_states_unconsumed
    on public.courieriq_oauth_states (state_id)
    where consumed_at is null;

create index if not exists idx_courieriq_active_trips_active
    on public.courieriq_active_trips (user_id, is_active, updated_at);
create index if not exists idx_courieriq_active_trips_session
    on public.courieriq_active_trips (session_id)
    where session_id is not null;
create index if not exists idx_courieriq_active_trips_user
    on public.courieriq_active_trips (user_id);

create unique index if not exists idx_courieriq_auth_email_identities_auth_account
    on public.courieriq_auth_email_identities (auth_account_id)
    where auth_account_id is not null;
create index if not exists idx_courieriq_auth_email_identities_user
    on public.courieriq_auth_email_identities (canonical_user_id);

create index if not exists idx_courieriq_payment_purchases_auth_account
    on public.courieriq_payment_purchases (auth_account_id, updated_at desc);
create index if not exists idx_courieriq_payment_purchases_status
    on public.courieriq_payment_purchases (status, updated_at desc);
create index if not exists idx_courieriq_payment_purchases_user
    on public.courieriq_payment_purchases (canonical_user_id, updated_at desc)
    where canonical_user_id is not null;

create index if not exists beta_access_requests_created_at_idx
    on public.beta_access_requests (created_at desc);
create index if not exists beta_access_requests_review_status_idx
    on public.beta_access_requests (status, created_at desc);
create index if not exists beta_access_requests_status_idx
    on public.beta_access_requests (status);
create index if not exists beta_access_events_request_idx
    on public.beta_access_request_events (request_id, created_at desc);

alter table public.beta_access_requests enable row level security;
alter table public.beta_access_request_events enable row level security;

grant usage on schema public to service_role;
grant all privileges on table public.beta_access_requests to service_role;
grant all privileges on table public.beta_access_request_events to service_role;
grant select, usage on sequence public.beta_access_request_events_id_seq to service_role;

-- Add the Google account used for Google Play closed-testing eligibility.

alter table public.beta_access_requests
    add column if not exists google_play_email text;

-- Existing applicants default to their contact email. New requests provide this
-- explicitly through the website form.
update public.beta_access_requests
set google_play_email = lower(btrim(email))
where google_play_email is null
   or btrim(google_play_email) = '';

alter table public.beta_access_requests
    alter column google_play_email set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'beta_access_google_play_email_format'
          and conrelid = 'public.beta_access_requests'::regclass
    ) then
        alter table public.beta_access_requests
            add constraint beta_access_google_play_email_format
            check (
                google_play_email ~*
                '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
            );
    end if;
end
$$;

create index if not exists beta_access_google_play_email_idx
on public.beta_access_requests (lower(google_play_email));
