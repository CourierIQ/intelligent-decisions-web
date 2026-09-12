create index bidlens_payment_events_user_idx
  on public.bidlens_payment_events(user_id);

create index scopefence_credit_orders_user_idx
  on public.scopefence_credit_orders(user_id);
