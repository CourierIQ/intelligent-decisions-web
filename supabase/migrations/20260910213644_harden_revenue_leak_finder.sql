alter function public.revenue_leak_record_analysis(
  uuid, text, text, text, integer, integer, integer, bigint, jsonb
) set search_path = '';

alter function public.revenue_leak_fulfill_purchase(
  text, text, text, uuid, text, integer, integer, integer, boolean
) set search_path = '';

create index if not exists revenue_leak_credit_ledger_user_idx
  on public.revenue_leak_credit_ledger(user_id);
