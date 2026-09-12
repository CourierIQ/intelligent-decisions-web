set local lock_timeout = '5s';

create schema if not exists private;

create table public.chargeback_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 120),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.chargeback_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.chargeback_organization_members (
  organization_id uuid not null references public.chargeback_organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamp with time zone not null default now(),
  primary key (organization_id, user_id)
);

create table public.chargeback_disputes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.chargeback_organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  assigned_to uuid references auth.users (id) on delete set null,
  merchant_name text not null check (char_length(merchant_name) between 1 and 120),
  case_reference text not null check (char_length(case_reference) between 1 and 100),
  order_reference text check (order_reference is null or char_length(order_reference) <= 100),
  processor text not null check (char_length(processor) between 1 and 100),
  reason_code text not null check (reason_code in ('unrecognized', 'not-received', 'not-described', 'duplicate', 'other')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (
    status in ('draft', 'evidence_needed', 'ready', 'submitted', 'under_review', 'won', 'partially_won', 'lost', 'closed')
  ),
  dispute_received_at date,
  response_due_at date,
  submitted_at timestamp with time zone,
  completed_at timestamp with time zone,
  recovery_cents bigint not null default 0 check (recovery_cents >= 0),
  readiness_score integer not null default 0 check (readiness_score between 0 and 100),
  summary text not null default '' check (char_length(summary) <= 10000),
  notes text not null default '' check (char_length(notes) <= 10000),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (id, organization_id)
);

create table public.chargeback_evidence_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dispute_id uuid not null,
  created_by uuid not null references auth.users (id) on delete restrict,
  storage_path text not null unique check (char_length(storage_path) between 5 and 1000),
  original_name text not null check (char_length(original_name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 1 and 150),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  category text not null default 'other' check (char_length(category) between 1 and 80),
  created_at timestamp with time zone not null default now(),
  foreign key (dispute_id, organization_id)
    references public.chargeback_disputes (id, organization_id) on delete cascade
);

create table public.chargeback_packs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.chargeback_organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'draft' check (status in ('draft', 'preview', 'payment_pending', 'unlocked')),
  tier_code text check (tier_code is null or tier_code in ('single', 'multi', 'volume', 'subscription')),
  case_count integer not null default 0 check (case_count between 0 and 10000),
  file_count integer not null default 0 check (file_count between 0 and 1000000),
  readiness_score integer not null default 0 check (readiness_score between 0 and 100),
  stripe_checkout_session_id text unique,
  unlocked_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (id, organization_id)
);

create table public.chargeback_pack_disputes (
  pack_id uuid not null,
  dispute_id uuid not null,
  organization_id uuid not null,
  position integer not null default 0 check (position >= 0),
  created_at timestamp with time zone not null default now(),
  primary key (pack_id, dispute_id),
  foreign key (pack_id, organization_id)
    references public.chargeback_packs (id, organization_id) on delete cascade,
  foreign key (dispute_id, organization_id)
    references public.chargeback_disputes (id, organization_id) on delete cascade
);

create table public.chargeback_dispute_events (
  id bigint generated by default as identity primary key,
  organization_id uuid not null,
  dispute_id uuid not null,
  actor_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('created', 'status_changed', 'note')),
  previous_status text,
  new_status text,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamp with time zone not null default now(),
  foreign key (dispute_id, organization_id)
    references public.chargeback_disputes (id, organization_id) on delete cascade
);

create index chargeback_disputes_org_status_idx
  on public.chargeback_disputes (organization_id, status, updated_at desc);
create index chargeback_disputes_due_idx
  on public.chargeback_disputes (organization_id, response_due_at)
  where status not in ('won', 'partially_won', 'lost', 'closed');
create index chargeback_evidence_dispute_idx
  on public.chargeback_evidence_files (dispute_id, created_at);
create index chargeback_packs_org_idx
  on public.chargeback_packs (organization_id, created_at desc);
create index chargeback_events_dispute_idx
  on public.chargeback_dispute_events (dispute_id, created_at desc);

create or replace function private.chargeback_is_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.chargeback_organization_members membership
      where membership.organization_id = target_organization_id
        and membership.user_id = (select auth.uid())
    );
$$;

create or replace function private.chargeback_is_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.chargeback_organization_members membership
      where membership.organization_id = target_organization_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'owner'
    );
$$;

create or replace function private.chargeback_storage_member(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
begin
  if object_name is null or split_part(object_name, '/', 1) !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  target_organization_id := split_part(object_name, '/', 1)::uuid;
  return private.chargeback_is_member(target_organization_id);
end;
$$;

create or replace function private.chargeback_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.chargeback_protect_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id <> old.organization_id or new.created_by <> old.created_by then
    raise exception 'Ownership fields cannot be changed.';
  end if;
  return new;
end;
$$;

create or replace function private.chargeback_log_dispute_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.chargeback_dispute_events (
      organization_id, dispute_id, actor_id, event_type, new_status
    ) values (
      new.organization_id, new.id, coalesce((select auth.uid()), new.created_by), 'created', new.status
    );
  elsif new.status is distinct from old.status then
    insert into public.chargeback_dispute_events (
      organization_id, dispute_id, actor_id, event_type, previous_status, new_status
    ) values (
      new.organization_id, new.id, coalesce((select auth.uid()), new.created_by),
      'status_changed', old.status, new.status
    );
  end if;
  return new;
end;
$$;

create or replace function private.chargeback_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_id uuid;
  organization_name text;
  display_name text;
begin
  display_name := nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 120), '');
  organization_name := nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'business_name', '')), 120), '');
  organization_name := coalesce(organization_name, display_name, split_part(new.email, '@', 1), 'My business');

  insert into public.chargeback_profiles (user_id, display_name)
  values (new.id, display_name);

  insert into public.chargeback_organizations (name, created_by)
  values (organization_name, new.id)
  returning id into organization_id;

  insert into public.chargeback_organization_members (organization_id, user_id, role)
  values (organization_id, new.id, 'owner');

  return new;
end;
$$;

create trigger chargeback_profiles_updated_at
before update on public.chargeback_profiles
for each row execute function private.chargeback_set_updated_at();
create trigger chargeback_organizations_updated_at
before update on public.chargeback_organizations
for each row execute function private.chargeback_set_updated_at();
create trigger chargeback_disputes_updated_at
before update on public.chargeback_disputes
for each row execute function private.chargeback_set_updated_at();
create trigger chargeback_packs_updated_at
before update on public.chargeback_packs
for each row execute function private.chargeback_set_updated_at();

create trigger chargeback_disputes_protect_ownership
before update on public.chargeback_disputes
for each row execute function private.chargeback_protect_ownership();
create trigger chargeback_evidence_protect_ownership
before update on public.chargeback_evidence_files
for each row execute function private.chargeback_protect_ownership();
create trigger chargeback_packs_protect_ownership
before update on public.chargeback_packs
for each row execute function private.chargeback_protect_ownership();

create trigger chargeback_disputes_log_status
after insert or update of status on public.chargeback_disputes
for each row execute function private.chargeback_log_dispute_status();

create trigger chargeback_on_auth_user_created
after insert on auth.users
for each row execute function private.chargeback_handle_new_user();

alter table public.chargeback_profiles enable row level security;
alter table public.chargeback_organizations enable row level security;
alter table public.chargeback_organization_members enable row level security;
alter table public.chargeback_disputes enable row level security;
alter table public.chargeback_evidence_files enable row level security;
alter table public.chargeback_packs enable row level security;
alter table public.chargeback_pack_disputes enable row level security;
alter table public.chargeback_dispute_events enable row level security;

create policy chargeback_profiles_select_own
on public.chargeback_profiles for select to authenticated
using ((select auth.uid()) = user_id);
create policy chargeback_profiles_update_own
on public.chargeback_profiles for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy chargeback_organizations_select_member
on public.chargeback_organizations for select to authenticated
using (private.chargeback_is_member(id));
create policy chargeback_organizations_update_owner
on public.chargeback_organizations for update to authenticated
using (private.chargeback_is_owner(id))
with check (private.chargeback_is_owner(id));

create policy chargeback_members_select_member
on public.chargeback_organization_members for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_members_insert_owner
on public.chargeback_organization_members for insert to authenticated
with check (private.chargeback_is_owner(organization_id));
create policy chargeback_members_update_owner
on public.chargeback_organization_members for update to authenticated
using (private.chargeback_is_owner(organization_id))
with check (private.chargeback_is_owner(organization_id));
create policy chargeback_members_delete_owner
on public.chargeback_organization_members for delete to authenticated
using (private.chargeback_is_owner(organization_id) and user_id <> (select auth.uid()));

create policy chargeback_disputes_select_member
on public.chargeback_disputes for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_disputes_insert_member
on public.chargeback_disputes for insert to authenticated
with check (private.chargeback_is_member(organization_id) and created_by = (select auth.uid()));
create policy chargeback_disputes_update_member
on public.chargeback_disputes for update to authenticated
using (private.chargeback_is_member(organization_id))
with check (private.chargeback_is_member(organization_id));
create policy chargeback_disputes_delete_member
on public.chargeback_disputes for delete to authenticated
using (private.chargeback_is_member(organization_id));

create policy chargeback_evidence_select_member
on public.chargeback_evidence_files for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_evidence_insert_member
on public.chargeback_evidence_files for insert to authenticated
with check (private.chargeback_is_member(organization_id) and created_by = (select auth.uid()));
create policy chargeback_evidence_update_member
on public.chargeback_evidence_files for update to authenticated
using (private.chargeback_is_member(organization_id))
with check (private.chargeback_is_member(organization_id));
create policy chargeback_evidence_delete_member
on public.chargeback_evidence_files for delete to authenticated
using (private.chargeback_is_member(organization_id));

create policy chargeback_packs_select_member
on public.chargeback_packs for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_packs_insert_member
on public.chargeback_packs for insert to authenticated
with check (private.chargeback_is_member(organization_id) and created_by = (select auth.uid()));
create policy chargeback_packs_update_member
on public.chargeback_packs for update to authenticated
using (private.chargeback_is_member(organization_id))
with check (private.chargeback_is_member(organization_id));
create policy chargeback_packs_delete_member
on public.chargeback_packs for delete to authenticated
using (private.chargeback_is_member(organization_id));

create policy chargeback_pack_disputes_select_member
on public.chargeback_pack_disputes for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_pack_disputes_insert_member
on public.chargeback_pack_disputes for insert to authenticated
with check (private.chargeback_is_member(organization_id));
create policy chargeback_pack_disputes_delete_member
on public.chargeback_pack_disputes for delete to authenticated
using (private.chargeback_is_member(organization_id));

create policy chargeback_events_select_member
on public.chargeback_dispute_events for select to authenticated
using (private.chargeback_is_member(organization_id));
create policy chargeback_events_insert_member
on public.chargeback_dispute_events for insert to authenticated
with check (private.chargeback_is_member(organization_id) and actor_id = (select auth.uid()));

revoke all on table public.chargeback_profiles from anon;
revoke all on table public.chargeback_organizations from anon;
revoke all on table public.chargeback_organization_members from anon;
revoke all on table public.chargeback_disputes from anon;
revoke all on table public.chargeback_evidence_files from anon;
revoke all on table public.chargeback_packs from anon;
revoke all on table public.chargeback_pack_disputes from anon;
revoke all on table public.chargeback_dispute_events from anon;

grant select, update on table public.chargeback_profiles to authenticated;
grant select, update on table public.chargeback_organizations to authenticated;
grant select, insert, update, delete on table public.chargeback_organization_members to authenticated;
grant select, insert, update, delete on table public.chargeback_disputes to authenticated;
grant select, insert, update, delete on table public.chargeback_evidence_files to authenticated;
grant select, insert, update, delete on table public.chargeback_packs to authenticated;
grant select, insert, delete on table public.chargeback_pack_disputes to authenticated;
grant select, insert on table public.chargeback_dispute_events to authenticated;
grant usage, select on sequence public.chargeback_dispute_events_id_seq to authenticated;

revoke all on function private.chargeback_is_member(uuid) from public, anon;
revoke all on function private.chargeback_is_owner(uuid) from public, anon;
revoke all on function private.chargeback_storage_member(text) from public, anon;
grant execute on function private.chargeback_is_member(uuid) to authenticated;
grant execute on function private.chargeback_is_owner(uuid) to authenticated;
grant execute on function private.chargeback_storage_member(text) to authenticated;
revoke all on function private.chargeback_handle_new_user() from public, anon, authenticated;
revoke all on function private.chargeback_log_dispute_status() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chargeback-evidence',
  'chargeback-evidence',
  false,
  26214400,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy chargeback_storage_select_member
on storage.objects for select to authenticated
using (bucket_id = 'chargeback-evidence' and private.chargeback_storage_member(name));
create policy chargeback_storage_insert_member
on storage.objects for insert to authenticated
with check (bucket_id = 'chargeback-evidence' and private.chargeback_storage_member(name));
create policy chargeback_storage_update_member
on storage.objects for update to authenticated
using (bucket_id = 'chargeback-evidence' and private.chargeback_storage_member(name))
with check (bucket_id = 'chargeback-evidence' and private.chargeback_storage_member(name));
create policy chargeback_storage_delete_member
on storage.objects for delete to authenticated
using (bucket_id = 'chargeback-evidence' and private.chargeback_storage_member(name));

alter table public.evidencelane_orders
  add column organization_id uuid references public.chargeback_organizations (id) on delete set null,
  add column user_id uuid references auth.users (id) on delete set null,
  add column pack_id uuid references public.chargeback_packs (id) on delete set null;

create index evidencelane_orders_pack_id_idx
  on public.evidencelane_orders (pack_id)
  where pack_id is not null;

comment on table public.chargeback_disputes is
  'Chargeback Studio disputes with deadlines, workflow status, and recovery values.';
comment on table public.chargeback_packs is
  'Chargeback Studio response packs; payment unlocks the clean final output.';
