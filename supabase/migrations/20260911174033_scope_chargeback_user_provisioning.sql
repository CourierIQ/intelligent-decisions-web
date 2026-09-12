set local lock_timeout = '5s';
set local statement_timeout = '15s';

create or replace function private.chargeback_provision_user(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_business_name text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_display_name text;
  v_organization_name text;
  v_organization_id uuid;
  v_created boolean := false;
begin
  if p_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  perform 1
  from auth.users
  where id = p_user_id
  for update;

  if not found then
    raise exception 'auth_user_not_found' using errcode = 'P0002';
  end if;

  v_display_name := nullif(left(btrim(coalesce(p_display_name, '')), 120), '');
  v_organization_name := coalesce(
    nullif(left(btrim(coalesce(p_business_name, '')), 120), ''),
    v_display_name,
    nullif(left(split_part(coalesce(p_email, ''), '@', 1), 120), ''),
    'My business'
  );

  insert into public.chargeback_profiles (user_id, display_name)
  values (p_user_id, v_display_name)
  on conflict (user_id) do nothing;

  select membership.organization_id
  into v_organization_id
  from public.chargeback_organization_members membership
  where membership.user_id = p_user_id
  order by
    case membership.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    membership.created_at,
    membership.organization_id
  limit 1;

  if v_organization_id is null then
    insert into public.chargeback_organizations (name, created_by)
    values (v_organization_name, p_user_id)
    returning id into v_organization_id;

    insert into public.chargeback_organization_members (
      organization_id,
      user_id,
      role
    ) values (
      v_organization_id,
      p_user_id,
      'owner'
    );

    v_created := true;
  end if;

  return jsonb_build_object(
    'organizationId', v_organization_id,
    'created', v_created
  );
end;
$function$;

revoke all on function private.chargeback_provision_user(
  uuid, text, text, text
) from public, anon, authenticated, service_role;

create or replace function private.chargeback_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_product text;
  v_business_name text;
  v_display_name text;
begin
  v_product := lower(btrim(coalesce(new.raw_app_meta_data ->> 'product', '')));
  v_business_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'business_name', '')), '');
  v_display_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');

  if v_product in ('chargeback_studio', 'chargeback-studio')
     or (
       v_product = ''
       and v_business_name is not null
       and v_display_name is not null
     ) then
    perform private.chargeback_provision_user(
      new.id,
      new.email,
      v_display_name,
      v_business_name
    );
  end if;

  return new;
end;
$function$;

revoke all on function private.chargeback_handle_new_user()
from public, anon, authenticated, service_role;

create or replace function public.chargeback_provision_current_user(
  p_display_name text default null,
  p_business_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_email text;
begin
  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select account.email
  into v_email
  from auth.users account
  where account.id = v_user_id;

  if not found then
    raise exception 'auth_user_not_found' using errcode = 'P0002';
  end if;

  return private.chargeback_provision_user(
    v_user_id,
    v_email,
    p_display_name,
    p_business_name
  );
end;
$function$;

revoke all on function public.chargeback_provision_current_user(
  text, text
) from public, anon, authenticated, service_role;

grant execute on function public.chargeback_provision_current_user(
  text, text
) to authenticated;

comment on function public.chargeback_provision_current_user(text, text) is
  'Idempotently provisions Chargeback Studio data for the currently authenticated user only.';

comment on function private.chargeback_handle_new_user() is
  'Compatibility-only Chargeback signup trigger. It ignores unrelated product signups and should be removed after the Chargeback client calls chargeback_provision_current_user.';

notify pgrst, 'reload schema';
