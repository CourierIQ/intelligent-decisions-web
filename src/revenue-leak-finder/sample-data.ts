export const SAMPLE_REVENUE_CSV = `payment_id,customer_id,email,amount,currency,status,subscription_status,paid_at
pay_1001,cus_100,ana@example.com,120.00,USD,paid,active,2026-08-02
pay_1002,cus_101,ben@example.com,89.00,USD,paid,active,2026-08-03
pay_1003,cus_102,chen@example.com,249.00,USD,paid,active,2026-08-04
pay_1004,cus_103,dia@example.com,49.00,USD,paid,past_due,2026-08-05
pay_1004,cus_103,dia@example.com,49.00,USD,paid,past_due,2026-08-05
pay_1005,cus_104,eli@example.com,199.00,EUR,succeeded,active,2026-08-06
pay_1006,cus_105,farah@example.com,75.00,USD,failed,canceled,2026-08-07`;

export const SAMPLE_LEDGER_CSV = `transaction_id,customer_id,email,total,currency,payment_status,plan_status,transaction_date
pay_1001,cus_100,ana@example.com,120.00,USD,paid,active,2026-08-02
pay_1002,cus_101,ben@example.com,79.00,USD,paid,active,2026-08-03
pay_1004,cus_103,dia@example.com,49.00,USD,paid,active,2026-08-05
pay_1005,cus_104,eli@example.com,199.00,USD,paid,active,2026-08-06
pay_1099,cus_109,gabe@example.com,310.00,USD,paid,active,2026-08-08
pay_1006,cus_105,farah@example.com,75.00,USD,void,canceled,2026-08-07`;
