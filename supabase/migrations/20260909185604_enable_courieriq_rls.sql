-- CourierIQ is currently inactive. Fail closed for public API access until
-- product-specific anon/authenticated policies are deliberately designed.
-- Backend clients using a Supabase secret/service-role key continue to bypass RLS.

alter table public.courieriq_users enable row level security;
alter table public.courieriq_sessions enable row level security;
alter table public.courieriq_trips enable row level security;
alter table public.courieriq_offers enable row level security;
alter table public.courieriq_offer_score_components enable row level security;
alter table public.courieriq_sync_batches enable row level security;
alter table public.courieriq_sync_records enable row level security;
alter table public.courieriq_auth_accounts enable row level security;
alter table public.courieriq_oauth_states enable row level security;
alter table public.courieriq_active_trips enable row level security;
alter table public.courieriq_auth_email_identities enable row level security;
alter table public.courieriq_payment_purchases enable row level security;
