# Chargeback Studio Stripe payment setup

Chargeback Studio owns the offer catalog, tier selection, totals review, and
post-payment entitlement flow. Stripe is used only for tax calculation and
payment processing through an embedded Payment Element backed by a server-side
PaymentIntent.

No Stripe Products, Prices, Payment Links, or hosted Checkout Sessions are used
for new purchases.

## On-site offers

- Starter: $29 USD, multiple disputes and up to 20 files
- Growth: $49 USD, multiple disputes and up to 50 files
- Volume: $79 USD, multiple disputes and up to 100 files
- More than 100 files routes to subscription pricing

The Worker validates the saved pack and selects the minimum eligible tier. The
browser cannot lower the amount by changing a request.

## Required Cloudflare bindings

Set these in the `intelligent-decisions-web` Worker. Never paste secret values
into chat or commit them.

Environment variables:

```text
STRIPE_PUBLISHABLE_KEY
```

Secrets:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

The publishable and secret keys must belong to the same Stripe account and mode
(both test or both live). The Worker also uses `SUPABASE_SECRET_KEY` and
`RESEND_API_KEY` for entitlement storage and notifications.

## Stripe Tax

The embedded Address Element collects the billing address. The Worker creates a
Stripe Tax Calculation for the fixed pack amount, shows the final tax and total
before confirmation, and links that calculation to the PaymentIntent.

Before live payments:

1. Add the business head-office address in Stripe Tax.
2. Add only jurisdictions where the business is registered to collect tax.
3. Set the account preset tax code, or configure `STRIPE_CHARGEBACK_TAX_CODE` as
   a normal Cloudflare environment variable.

## Webhook destination

The application-owned webhook endpoint is:

```text
https://intelligentdecisions.io/api/stripe/webhook
```

Subscribe to:

```text
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
```

Store the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET` in Cloudflare.
The handler verifies the exact raw body, rejects stale or invalid signatures,
records Stripe event IDs for idempotency, and unlocks the matching pack only
after a signed `payment_intent.succeeded` event.

## Verification flow

1. Build and save one or more disputes in a response pack.
2. Confirm the marked preview retains its watermark.
3. Select the eligible on-site tier and open the embedded payment dialog.
4. Enter a billing address and payment method, then calculate the final total.
5. Confirm the displayed subtotal, tax, and total before submitting payment.
6. Confirm the signed webhook creates one `evidencelane_orders` row and one
   `stripe_webhook_events` row.
7. Confirm the purchased pack unlocks its clean, unmarked output.
8. Replay the webhook and confirm no duplicate order or email is created.

Use Stripe test mode for the complete flow before enabling matching live keys.
