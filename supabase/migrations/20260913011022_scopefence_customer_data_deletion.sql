-- Keep the minimum payment audit record after a customer deletes their
-- ScopeFence workspace, without retaining a link back to the deleted account.
alter table public.scopefence_credit_orders
  drop constraint if exists scopefence_credit_orders_user_id_fkey;

alter table public.scopefence_credit_orders
  alter column user_id drop not null;

alter table public.scopefence_credit_orders
  add constraint scopefence_credit_orders_user_id_fkey
  foreign key (user_id)
  references public.scopefence_accounts(user_id)
  on delete set null;

comment on column public.scopefence_credit_orders.user_id is
  'ScopeFence account receiving the purchase. Set to null when the customer deletes their ScopeFence workspace; payment audit fields remain for accounting, fraud prevention, and webhook idempotency.';

-- A delayed or replayed Stripe event must never recreate a workspace that the
-- customer deleted. Checkout creation always ensures the account first, so a
-- missing account here means it was deleted after checkout began.
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
  balance integer := 0;
begin
  if p_user_id is null or p_sku <> 'analyses_20' or p_credits <> 20 or p_amount_total <> 2900 or
     p_amount_tax < 0 or p_amount_tax > p_amount_total or p_currency <> 'usd' then
    raise exception 'invalid_scopefence_purchase';
  end if;

  insert into public.scopefence_credit_orders(
    event_id,
    payment_intent_id,
    user_id,
    sku,
    credits,
    amount_total,
    amount_tax,
    currency,
    live_mode
  )
  select
    btrim(p_event_id),
    btrim(p_payment_intent_id),
    account.user_id,
    p_sku,
    p_credits,
    p_amount_total,
    p_amount_tax,
    p_currency,
    p_live_mode
  from public.scopefence_accounts as account
  where account.user_id = p_user_id
  on conflict do nothing;

  if found then
    update public.scopefence_accounts
    set paid_credit_balance = scopefence_accounts.paid_credit_balance + p_credits,
        updated_at = now()
    where user_id = p_user_id
    returning scopefence_accounts.paid_credit_balance into balance;

    if balance is not null then
      return query select true, balance;
      return;
    end if;
  end if;

  -- Preserve an idempotency/accounting record when the account disappeared
  -- before payment confirmation. This row intentionally has no customer link.
  insert into public.scopefence_credit_orders(
    event_id,
    payment_intent_id,
    user_id,
    sku,
    credits,
    amount_total,
    amount_tax,
    currency,
    live_mode
  ) values (
    btrim(p_event_id),
    btrim(p_payment_intent_id),
    null,
    p_sku,
    p_credits,
    p_amount_total,
    p_amount_tax,
    p_currency,
    p_live_mode
  )
  on conflict do nothing;

  select coalesce(account.paid_credit_balance, 0)
  into balance
  from public.scopefence_accounts as account
  where account.user_id = p_user_id;

  return query select false, coalesce(balance, 0);
end;
$$;

revoke all on function public.scopefence_fulfill_credit_purchase(text, text, uuid, text, text, integer, integer, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.scopefence_fulfill_credit_purchase(text, text, uuid, text, text, integer, integer, integer, text, boolean)
  to service_role;
