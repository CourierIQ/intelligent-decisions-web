# IDI Stripe payment routing

The public products share one Stripe account and one application-owned webhook,
but each product keeps its own server-side entitlement path. Product metadata
on the signed Stripe object determines which handler receives the event.

Chargeback Studio uses an embedded Payment Element backed by a server-created
PaymentIntent. Revenue Leak Finder, BidLens, and ScopeFence use server-created
hosted Checkout Sessions. New Chargeback Studio purchases do not use Stripe
Products, Prices, Payment Links, or hosted Checkout Sessions.

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
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
```

Store the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET` in Cloudflare.
The handler verifies the exact raw body and rejects stale or invalid signatures.
It grants an entitlement only after a signed, paid success event. Failed or
incomplete payments are acknowledged without granting access.

## Product routing

| Product | Stripe flow | Routing metadata | Entitlement target |
| --- | --- | --- | --- |
| Chargeback Studio | PaymentIntent | `offer_code` | Purchased response pack and order |
| Revenue Leak Finder | Checkout Session | `revenue_leak_flow` | Report credits |
| BidLens | Checkout Session | `bidlens_flow` | RFP-analysis credits |
| ScopeFence | Checkout Session | `scopefence_flow` | Scope-analysis credits |

The Checkout products copy their non-sensitive product, user, SKU, and credit
metadata to the underlying PaymentIntent for Stripe Dashboard reconciliation.
Fulfillment remains driven by the signed Checkout Session event, and each
product's database function uses Stripe identifiers to make credit grants
idempotent.

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

For each Checkout product, complete one test purchase, confirm the exact credit
quantity is granted once, then replay the success event and confirm the balance
does not change. Confirm an unpaid completion or asynchronous failure grants no
credits, and an asynchronous success grants them exactly once.

Use Stripe test mode for the complete flow before enabling matching live keys.
