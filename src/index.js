import {
  fulfillRevenueLeakStripeEvent,
  handleRevenueLeakApi,
  isRevenueLeakStripeEvent,
} from "./revenue-leak-api.js";
import {
  fulfillBidLensStripeEvent,
  handleBidLensApi,
  isBidLensStripeEvent,
} from "./bidlens-api.js";
import {
  fulfillScopeFenceStripeEvent,
  handleScopeFenceApi,
  isScopeFenceStripeEvent,
} from "./scopefence-api.js";

"use strict";

const ALLOWED_HOSTNAMES = new Set([
  "intelligentdecisions.io",
  "www.intelligentdecisions.io",
]);
const SUPABASE_BROWSER_ORIGIN = "https://jlbtbpngvqyaiatslphi.supabase.co";
const SUPABASE_BROWSER_SOCKET_ORIGIN = "wss://jlbtbpngvqyaiatslphi.supabase.co";
const CHARGEBACK_JSON_LD_HASH = "'sha256-CeWR5X2Yc5Q5PE02aGYqfbaN9hwJ2VTGq1A1Ph9rpNI='";
const INSIGHT_JSON_LD_HASH = "'sha256-81aEH7XxxkGx983XTGYRJ3Rvup8FflNXlJUXOEORX8Y='";
const BETA_NOTIFICATION_TO = "bhall@intelligentdecisions.io";
const ALLOWED_PLATFORMS = new Set([
  "Uber Eats",
  "DoorDash",
  "Grubhub",
  "Spark",
  "Instacart",
  "Other",
]);
const ALLOWED_WEEKLY_DELIVERIES = new Set([
  "1-10",
  "11-25",
  "26-50",
  "51-100",
  "100+",
]);
const ALLOWED_STATUSES = new Set([
  "pending",
  "approved",
  "invited",
  "active",
  "declined",
]);
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TURNSTILE_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const STRIPE_API_ENDPOINT = "https://api.stripe.com/v1";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const EVIDENCELANE_TIERS = Object.freeze({
  single: Object.freeze({
    code: "single",
    offerCode: "evidencelane_pack_20",
    label: "Starter",
    amount: 2900,
    maxCases: Number.MAX_SAFE_INTEGER,
    maxFiles: 20,
  }),
  multi: Object.freeze({
    code: "multi",
    offerCode: "evidencelane_pack_50",
    label: "Growth",
    amount: 4900,
    maxCases: Number.MAX_SAFE_INTEGER,
    maxFiles: 50,
  }),
  volume: Object.freeze({
    code: "volume",
    offerCode: "evidencelane_pack_100",
    label: "Volume",
    amount: 7900,
    maxCases: Number.MAX_SAFE_INTEGER,
    maxFiles: 100,
  }),
});
const EVIDENCELANE_OFFER_CODES = new Set(
  Object.values(EVIDENCELANE_TIERS).map((tier) => tier.offerCode),
);
const EVIDENCELANE_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);
const BETA_FROM_EMAIL =
  "CourierIQ Beta <beta@intelligentdecisions.io>";
const EVIDENCELANE_FROM_EMAIL =
  "Chargeback Studio <evidencelane@intelligentdecisions.io>";
const ADMIN_REQUEST_SELECT = [
  "id",
  "first_name",
  "email",
  "google_play_email",
  "state",
  "android_device",
  "delivery_platforms",
  "weekly_deliveries",
  "interest_reason",
  "status",
  "admin_notes",
  "reviewed_at",
  "reviewed_by",
  "invited_at",
  "invite_resend_id",
  "invite_email_status",
  "invite_email_error",
  "admin_email_status",
  "applicant_email_status",
  "admin_resend_id",
  "applicant_resend_id",
  "last_email_error",
  "created_at",
  "updated_at",
].join(",");

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function cleanString(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").trim().slice(0, maximumLength);
}

function isValidEmail(email) {
  return (
    email.length <= 254 &&
    /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)
  );
}

function isAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    return (
      originUrl.protocol === "https:" &&
      ALLOWED_HOSTNAMES.has(originUrl.hostname)
    );
  } catch {
    return false;
  }
}

function getAccessEmail(request) {
  return cleanString(
    request.headers.get("cf-access-authenticated-user-email"),
    254,
  ).toLowerCase();
}

function requireAdmin(request) {
  const email = getAccessEmail(request);

  // Cloudflare Access owns the administrator allowlist for /admin/*.
  // Any authenticated email that reaches this Worker has already passed
  // the Access policy, so do not duplicate that allowlist in application code.
  if (!email) {
    return {
      response: jsonResponse(
        { success: false, message: "Administrator access is required." },
        403,
      ),
    };
  }

  return { email };
}

function validateSubmission(payload) {
  const firstName = cleanString(payload.first_name, 80);
  const email = cleanString(payload.email, 254).toLowerCase();
  const googlePlayEmail = cleanString(
    payload.google_play_email,
    254,
  ).toLowerCase();
  const state = cleanString(payload.state, 80);
  const androidDevice = cleanString(payload.android_device, 120);
  const weeklyDeliveries = cleanString(payload.weekly_deliveries, 20);
  const interestReason = cleanString(payload.interest_reason, 1000);
  const turnstileToken = cleanString(payload.turnstile_token, 2048);
  const website = cleanString(payload.website, 200);
  const deliveryPlatforms = Array.isArray(payload.delivery_platforms)
    ? [
        ...new Set(
          payload.delivery_platforms
            .map((platform) => cleanString(platform, 40))
            .filter((platform) => ALLOWED_PLATFORMS.has(platform)),
        ),
      ]
    : [];

  if (website) return { honeypot: true };
  if (firstName.length < 1) return { error: "Enter your first name." };
  if (!isValidEmail(email)) return { error: "Enter a valid contact email address." };
  if (!isValidEmail(googlePlayEmail)) {
    return { error: "Enter a valid Google Play account email." };
  }
  if (state && state.length < 2) return { error: "Enter a valid state." };
  if (androidDevice.length < 2) {
    return { error: "Enter the Android device you use." };
  }
  if (!deliveryPlatforms.length) {
    return { error: "Select at least one delivery platform." };
  }
  if (!ALLOWED_WEEKLY_DELIVERIES.has(weeklyDeliveries)) {
    return { error: "Select your approximate deliveries per week." };
  }
  if (payload.consent !== true) {
    return { error: "Consent is required to request beta access." };
  }
  if (!turnstileToken) {
    return { error: "Complete the verification before submitting." };
  }

  return {
    data: {
      firstName,
      email,
      googlePlayEmail,
      state: state || null,
      androidDevice,
      deliveryPlatforms,
      weeklyDeliveries,
      interestReason: interestReason || null,
      turnstileToken,
    },
  };
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function chargebackStudioUrl(env) {
  try {
    const url = new URL(env.CHARGEBACK_STUDIO_URL || env.EVIDENCELANE_ORIGIN || "");
    return url.protocol === "https:" ? url.href.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

function evidenceLaneOrigin(env) {
  const siteUrl = chargebackStudioUrl(env);
  return siteUrl ? new URL(siteUrl).origin : "";
}

function isAllowedCheckoutOrigin(request, env) {
  const origin = request.headers.get("Origin");

  try {
    // Browsers normally omit Origin on same-origin GET requests. In that case,
    // validate the actual request URL; cross-origin browser requests still send
    // Origin and are checked against the allowlist below.
    const originUrl = new URL(origin || request.url);
    return (
      originUrl.protocol === "https:" &&
      (ALLOWED_HOSTNAMES.has(originUrl.hostname) ||
        originUrl.origin === evidenceLaneOrigin(env))
    );
  } catch {
    return false;
  }
}

function evidenceLaneCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== evidenceLaneOrigin(env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type",
    Vary: "Origin",
  };
}

function resolveEvidenceLaneTier(caseCount, fileCount) {
  return Object.values(EVIDENCELANE_TIERS).find(
    (tier) => caseCount <= tier.maxCases && fileCount <= tier.maxFiles,
  ) || null;
}

function evidenceLaneTierFromOfferCode(offerCode) {
  return Object.values(EVIDENCELANE_TIERS).find(
    (tier) => tier.offerCode === offerCode,
  ) || null;
}

async function stripeApiRequest(path, parameters, idempotencyKey, env) {
  const response = await fetchWithTimeout(
    `${STRIPE_API_ENDPOINT}${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body: parameters.toString(),
    },
    10000,
  );
  const responseText = await response.text();
  let result = {};

  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }
  }

  if (!response.ok) {
    console.error(
      "Stripe API request failed",
      response.status,
      result?.error?.type || "unknown_error",
      result?.error?.code || "unknown_code",
    );
    const error = new Error(`Stripe API request failed (${response.status}).`);
    error.stripeCode = cleanString(result?.error?.code, 100);
    throw error;
  }

  return result;
}

async function stripeApiGet(path, env) {
  const response = await fetchWithTimeout(
    `${STRIPE_API_ENDPOINT}${path}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
    10000,
  );
  const responseText = await response.text();
  let result = {};
  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }
  }
  if (!response.ok) {
    console.error(
      "Stripe API request failed",
      response.status,
      result?.error?.type || "unknown_error",
      result?.error?.code || "unknown_code",
    );
    throw new Error(`Stripe API request failed (${response.status}).`);
  }
  return result;
}

function stripeKeyMode(value) {
  const key = cleanString(value, 255);
  if (/^(?:sk|rk|pk)_live_/.test(key)) return "live";
  if (/^(?:sk|rk|pk)_test_/.test(key)) return "test";
  return "unknown";
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeBillingAddress(value) {
  const address = value && typeof value === "object" ? value : {};
  const country = cleanString(address.country, 2).toUpperCase();
  const postalCode = cleanString(address.postal_code, 20);
  if (!/^[A-Z]{2}$/.test(country) || !postalCode) return null;
  return {
    line1: cleanString(address.line1, 200),
    line2: cleanString(address.line2, 200),
    city: cleanString(address.city, 120),
    state: cleanString(address.state, 120),
    postalCode,
    country,
  };
}

function parseStripeSignature(signatureHeader) {
  const parsed = { timestamp: 0, signatures: [] };
  for (const part of String(signatureHeader || "").split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") parsed.timestamp = Number(value);
    if (key === "v1") parsed.signatures.push(value);
  }
  return parsed;
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!Number.isInteger(timestamp) || !signatures.length) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedPayload = encoder.encode(`${timestamp}.${rawBody}`);

  for (const signature of signatures) {
    const signatureBytes = hexToBytes(signature);
    if (
      signatureBytes &&
      (await crypto.subtle.verify("HMAC", key, signatureBytes, signedPayload))
    ) {
      return true;
    }
  }
  return false;
}

async function verifyTurnstile(token, request, env) {
  const remoteIp = request.headers.get("CF-Connecting-IP") || undefined;
  let response;

  try {
    response = await fetchWithTimeout(
      TURNSTILE_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: remoteIp,
          idempotency_key: crypto.randomUUID(),
        }),
      },
      8000,
    );
  } catch (error) {
    console.error("Turnstile request failed", error);
    return { serviceError: true };
  }

  if (!response.ok) {
    console.error("Turnstile returned HTTP", response.status);
    return { serviceError: true };
  }

  const result = await response.json();
  return {
    success:
      result.success === true &&
      result.action === "beta_access" &&
      ALLOWED_HOSTNAMES.has(result.hostname),
  };
}

function supabaseHeaders(env, prefer) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function supabaseBaseUrl(env) {
  return env.SUPABASE_URL.replace(/\/+$/, "");
}

async function supabaseRequest(path, options, env, timeoutMs = 10000) {
  const response = await fetchWithTimeout(
    `${supabaseBaseUrl(env)}/rest/v1/${path}`,
    options,
    timeoutMs,
  );
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase request failed (${response.status}): ${String(text).slice(0, 500)}`,
    );
  }

  return { response, body };
}

async function authenticateChargebackUser(request, env) {
  const authorization = cleanString(request.headers.get("Authorization"), 4096);
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY;
  if (!authorization.startsWith("Bearer ") || !env.SUPABASE_URL || !publishableKey) {
    return null;
  }

  const headers = {
    Accept: "application/json",
    apikey: publishableKey,
    Authorization: authorization,
  };
  const response = await fetchWithTimeout(
    `${supabaseBaseUrl(env)}/auth/v1/user`,
    { method: "GET", headers },
    10000,
  );
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Supabase Auth verification failed (${response.status}).`);
  const user = await response.json();
  return user?.id && user?.email ? user : null;
}

async function getChargebackPackContext(packId, userId, env) {
  const packQuery =
    `chargeback_packs?id=eq.${encodeURIComponent(packId)}` +
    "&select=id,organization_id,name,status,stripe_checkout_session_id,stripe_payment_intent_id&limit=1";
  const { body: packs } = await supabaseRequest(
    packQuery,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  const pack = Array.isArray(packs) ? packs[0] : null;
  if (!pack?.id || !pack?.organization_id) return null;

  const membershipQuery =
    `chargeback_organization_members?organization_id=eq.${encodeURIComponent(pack.organization_id)}` +
    `&user_id=eq.${encodeURIComponent(userId)}&select=role&limit=1`;
  const { body: memberships } = await supabaseRequest(
    membershipQuery,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  if (!Array.isArray(memberships) || !memberships.length) return null;

  const linksQuery =
    `chargeback_pack_disputes?pack_id=eq.${encodeURIComponent(packId)}` +
    "&select=dispute_id&order=position.asc";
  const { body: links } = await supabaseRequest(
    linksQuery,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  const disputeIds = Array.isArray(links)
    ? links.map((entry) => cleanString(entry.dispute_id, 80)).filter(Boolean)
    : [];
  let fileCount = 0;
  if (disputeIds.length) {
    const evidenceQuery =
      `chargeback_evidence_files?dispute_id=in.(${disputeIds.join(",")})` +
      "&select=id";
    const { body: evidence } = await supabaseRequest(
      evidenceQuery,
      { method: "GET", headers: supabaseHeaders(env) },
      env,
    );
    fileCount = Array.isArray(evidence) ? evidence.length : 0;
  }

  return {
    pack,
    caseCount: disputeIds.length,
    fileCount,
  };
}

async function updateChargebackPack(packId, changes, env) {
  await supabaseRequest(
    `chargeback_packs?id=eq.${encodeURIComponent(packId)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(env, "return=minimal"),
      body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }),
    },
    env,
  );
}

async function upsertApplication(application, env) {
  const query =
    "beta_access_requests?on_conflict=email_normalized" +
    "&select=id,status,admin_email_status,applicant_email_status,created_at";
  const now = new Date().toISOString();
  const { body } = await supabaseRequest(
    query,
    {
      method: "POST",
      headers: supabaseHeaders(
        env,
        "resolution=merge-duplicates,return=representation",
      ),
      body: JSON.stringify([
        {
          first_name: application.firstName,
          email: application.email,
          google_play_email: application.googlePlayEmail,
          state: application.state,
          android_device: application.androidDevice,
          delivery_platforms: application.deliveryPlatforms,
          weekly_deliveries: application.weeklyDeliveries,
          interest_reason: application.interestReason,
          consent_at: now,
          source: "idi_website",
          updated_at: now,
        },
      ]),
    },
    env,
  );

  const storedApplication = Array.isArray(body) ? body[0] : null;
  if (!storedApplication?.id) {
    throw new Error("Supabase did not return the stored application.");
  }
  return storedApplication;
}

async function updateApplication(applicationId, changes, env, select = "") {
  const query =
    `beta_access_requests?id=eq.${encodeURIComponent(applicationId)}` +
    (select ? `&select=${encodeURIComponent(select)}` : "");
  const { body } = await supabaseRequest(
    query,
    {
      method: "PATCH",
      headers: supabaseHeaders(
        env,
        select ? "return=representation" : "return=minimal",
      ),
      body: JSON.stringify({
        ...changes,
        updated_at: new Date().toISOString(),
      }),
    },
    env,
  );
  return select && Array.isArray(body) ? body[0] : null;
}

async function getApplication(applicationId, env) {
  const query =
    `beta_access_requests?id=eq.${encodeURIComponent(applicationId)}` +
    `&select=${encodeURIComponent(ADMIN_REQUEST_SELECT)}&limit=1`;
  const { body } = await supabaseRequest(
    query,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  return Array.isArray(body) ? body[0] || null : null;
}

async function listApplications(status, env) {
  let query =
    `beta_access_requests?select=${encodeURIComponent(ADMIN_REQUEST_SELECT)}` +
    "&order=created_at.desc&limit=250";
  if (status && ALLOWED_STATUSES.has(status)) {
    query += `&status=eq.${encodeURIComponent(status)}`;
  }
  const { body } = await supabaseRequest(
    query,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  return Array.isArray(body) ? body : [];
}

async function listEvents(applicationId, env) {
  const query =
    "beta_access_request_events" +
    `?request_id=eq.${encodeURIComponent(applicationId)}` +
    "&select=id,event_type,actor_email,previous_status,new_status,details,created_at" +
    "&order=created_at.desc&limit=100";
  const { body } = await supabaseRequest(
    query,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  return Array.isArray(body) ? body : [];
}

async function insertEvent(event, env) {
  await supabaseRequest(
    "beta_access_request_events",
    {
      method: "POST",
      headers: supabaseHeaders(env, "return=minimal"),
      body: JSON.stringify([event]),
    },
    env,
  );
}

async function hasProcessedStripeEvent(eventId, env) {
  const query =
    "stripe_webhook_events" +
    `?event_id=eq.${encodeURIComponent(eventId)}` +
    "&select=event_id&limit=1";
  const { body } = await supabaseRequest(
    query,
    { method: "GET", headers: supabaseHeaders(env) },
    env,
  );
  return Array.isArray(body) && body.length > 0;
}

async function upsertEvidenceLaneOrder(paymentObject, eventType, env) {
  const isPaymentIntent = paymentObject?.object === "payment_intent";
  const conflictColumn = isPaymentIntent
    ? "stripe_payment_intent_id"
    : "stripe_checkout_session_id";
  const query =
    `evidencelane_orders?on_conflict=${conflictColumn}` +
    "&select=id,order_reference,batch_id,pack_id,organization_id,user_id,tier_code,case_count,file_count,customer_email,amount_total,currency,payment_status";
  const customerEmail = cleanString(
    isPaymentIntent
      ? paymentObject.receipt_email || paymentObject.metadata?.customer_email
      : paymentObject.customer_details?.email,
    254,
  ).toLowerCase();
  const tier = evidenceLaneTierFromOfferCode(
    cleanString(paymentObject.metadata?.offer_code, 80),
  );
  if (!tier) throw new Error("Stripe payment contains an unknown Chargeback Studio tier.");
  const orderReference = cleanString(
    paymentObject.metadata?.order_reference || paymentObject.client_reference_id,
    80,
  );
  const batchId = cleanString(paymentObject.metadata?.batch_id, 80);
  const caseCount = Number(paymentObject.metadata?.case_count);
  const fileCount = Number(paymentObject.metadata?.file_count);
  const now = new Date().toISOString();
  const paid = isPaymentIntent
    ? paymentObject.status === "succeeded"
    : paymentObject.payment_status === "paid";
  const { body } = await supabaseRequest(
    query,
    {
      method: "POST",
      headers: supabaseHeaders(
        env,
        "resolution=merge-duplicates,return=representation",
      ),
      body: JSON.stringify([
        {
          order_reference: orderReference,
          batch_id: batchId,
          pack_id: cleanString(paymentObject.metadata?.pack_id, 80) || null,
          organization_id: cleanString(paymentObject.metadata?.organization_id, 80) || null,
          user_id: cleanString(paymentObject.metadata?.user_id, 80) || null,
          offer_code: tier.offerCode,
          tier_code: tier.code,
          case_count: Number.isInteger(caseCount) ? caseCount : 0,
          file_count: Number.isInteger(fileCount) ? fileCount : 0,
          stripe_checkout_session_id: isPaymentIntent
            ? null
            : cleanString(paymentObject.id, 255),
          stripe_payment_intent_id: isPaymentIntent
            ? cleanString(paymentObject.id, 255)
            : cleanString(
                typeof paymentObject.payment_intent === "string"
                  ? paymentObject.payment_intent
                  : paymentObject.payment_intent?.id,
                255,
              ) || null,
          stripe_customer_id: cleanString(
            typeof paymentObject.customer === "string"
              ? paymentObject.customer
              : paymentObject.customer?.id,
            255,
          ) || null,
          customer_email: customerEmail || null,
          amount_total: Number.isInteger(isPaymentIntent ? paymentObject.amount : paymentObject.amount_total)
            ? (isPaymentIntent ? paymentObject.amount : paymentObject.amount_total)
            : null,
          amount_tax: Number.isInteger(
            isPaymentIntent
              ? Number(paymentObject.metadata?.amount_tax)
              : paymentObject.total_details?.amount_tax,
          )
            ? (isPaymentIntent
                ? Number(paymentObject.metadata?.amount_tax)
                : paymentObject.total_details.amount_tax)
            : null,
          currency: cleanString(paymentObject.currency, 3).toLowerCase() || null,
          payment_status: paid ? "paid" : "unpaid",
          checkout_status: paid || paymentObject.status === "canceled" ? "complete" : "open",
          last_event_type: cleanString(eventType, 100),
          livemode: paymentObject.livemode === true,
          paid_at: paid ? now : null,
          updated_at: now,
        },
      ]),
    },
    env,
  );

  const order = Array.isArray(body) ? body[0] : null;
  if (!order?.id) throw new Error("Supabase did not return the EvidenceLane order.");
  return order;
}

async function insertStripeWebhookEvent(event, objectId, env) {
  await supabaseRequest(
    "stripe_webhook_events",
    {
      method: "POST",
      headers: supabaseHeaders(env, "return=minimal"),
      body: JSON.stringify([
        {
          event_id: cleanString(event.id, 255),
          event_type: cleanString(event.type, 100),
          object_id: cleanString(objectId, 255) || null,
          livemode: event.livemode === true,
        },
      ]),
    },
    env,
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatSubmissionTime(value = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatCurrency(amount, currency) {
  if (!Number.isInteger(amount) || !currency) return "Unknown amount";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
}

async function sendResendEmail(message, idempotencyKey, env) {
  const response = await fetchWithTimeout(
    RESEND_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(message),
    },
    10000,
  );

  const responseText = await response.text();
  let result = {};
  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }
  }

  if (!response.ok || !result.id) {
    throw new Error(
      `Resend failed (${response.status}): ${
        result.message || responseText.slice(0, 300) || "Unknown error"
      }`,
    );
  }
  return result.id;
}

function buildAdminEmail(application) {
  const state = application.state || "Not provided";
  const reason = application.interestReason || "Not provided";
  const platforms = application.deliveryPlatforms.join(", ");
  const submittedAt = formatSubmissionTime();

  return {
    from: BETA_FROM_EMAIL,
    to: [BETA_NOTIFICATION_TO],
    subject: `New CourierIQ Beta Request — ${application.firstName}`,
    reply_to: application.email,
    tags: [
      { name: "type", value: "beta-access" },
      { name: "source", value: "idi-website" },
    ],
    html: `
      <h1>New CourierIQ beta request</h1>
      <p><strong>Applicant:</strong> ${escapeHtml(application.firstName)}</p>
      <p><strong>Contact email:</strong> ${escapeHtml(application.email)}</p>
      <p><strong>Google Play email:</strong> ${escapeHtml(application.googlePlayEmail)}</p>
      <p><strong>State:</strong> ${escapeHtml(state)}</p>
      <p><strong>Android device:</strong> ${escapeHtml(application.androidDevice)}</p>
      <p><strong>Platforms:</strong> ${escapeHtml(platforms)}</p>
      <p><strong>Deliveries per week:</strong> ${escapeHtml(application.weeklyDeliveries)}</p>
      <p><strong>Interest:</strong><br>${escapeHtml(reason).replaceAll("\n", "<br>")}</p>
      <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)} ET</p>
    `,
    text: [
      "New CourierIQ beta request",
      "",
      `Applicant: ${application.firstName}`,
      `Contact email: ${application.email}`,
      `Google Play email: ${application.googlePlayEmail}`,
      `State: ${state}`,
      `Android device: ${application.androidDevice}`,
      `Platforms: ${platforms}`,
      `Deliveries per week: ${application.weeklyDeliveries}`,
      `Interest: ${reason}`,
      `Submitted: ${submittedAt} ET`,
    ].join("\n"),
  };
}

function buildApplicantEmail(application) {
  return {
    from: BETA_FROM_EMAIL,
    to: [application.email],
    subject: "We received your CourierIQ beta request",
    reply_to: BETA_NOTIFICATION_TO,
    tags: [
      { name: "type", value: "beta-confirmation" },
      { name: "source", value: "idi-website" },
    ],
    html: `
      <h1>We received your request.</h1>
      <p>Hi ${escapeHtml(application.firstName)},</p>
      <p>Thanks for requesting access to the CourierIQ private beta.</p>
      <p>We recorded <strong>${escapeHtml(application.googlePlayEmail)}</strong> as the Google Play account for tester eligibility.</p>
      <p>We have received your information and will review it as beta capacity becomes available. Submitting a request does not guarantee immediate access.</p>
      <p>— Intelligent Decisions Interactive<br>Clarity over Complexity.</p>
    `,
    text: [
      `Hi ${application.firstName},`,
      "",
      "Thanks for requesting access to the CourierIQ private beta.",
      "",
      `Google Play account for tester eligibility: ${application.googlePlayEmail}`,
      "",
      "We have received your information and will review it as beta capacity becomes available. Submitting a request does not guarantee immediate access.",
      "",
      "— Intelligent Decisions Interactive",
      "Clarity over Complexity.",
    ].join("\n"),
  };
}

function buildEvidenceLaneCustomerEmail(order, env) {
  const amount = formatCurrency(order.amount_total, order.currency);
  const siteUrl = chargebackStudioUrl(env);
  return {
    from: EVIDENCELANE_FROM_EMAIL,
    to: [order.customer_email],
    subject: "Your Chargeback Studio pack is unlocked",
    reply_to: BETA_NOTIFICATION_TO,
    tags: [
      { name: "type", value: "evidencelane-order" },
      { name: "source", value: "stripe-checkout" },
    ],
    html: `
      <h1>Your clean Chargeback Studio pack is unlocked.</h1>
      <p>We received your ${escapeHtml(amount)} payment for the ${escapeHtml(order.tier_code)} tier.</p>
      <p><strong>Order reference:</strong> ${escapeHtml(order.order_reference)}</p>
      <p><strong>Batch:</strong> ${order.case_count} case${order.case_count === 1 ? "" : "s"} · ${order.file_count} file${order.file_count === 1 ? "" : "s"}</p>
      <p><a href="${escapeHtml(siteUrl)}">Open Chargeback Studio</a> and sign in to generate the clean, unmarked pack from your private workspace.</p>
      <p>Chargeback Studio does not submit disputes or guarantee outcomes. Confirm every statement and your processor’s current requirements before submission.</p>
      <p>— Chargeback Studio by Intelligent Decisions Interactive</p>
    `,
    text: [
      "Your Chargeback Studio order is confirmed.",
      "",
      `Payment: ${amount}`,
      `Order reference: ${order.order_reference}`,
      `Batch: ${order.case_count} case(s), ${order.file_count} file(s)`,
      `Open Chargeback Studio: ${siteUrl}`,
      "",
      "Open Chargeback Studio and sign in to generate the clean, unmarked pack from your private workspace.",
      "Chargeback Studio does not submit disputes or guarantee outcomes. Confirm every statement and your processor's current requirements before submission.",
      "",
      "— Chargeback Studio by Intelligent Decisions Interactive",
    ].join("\n"),
  };
}

function buildEvidenceLaneAdminEmail(order) {
  const amount = formatCurrency(order.amount_total, order.currency);
  return {
    from: EVIDENCELANE_FROM_EMAIL,
    to: [BETA_NOTIFICATION_TO],
    subject: `Paid Chargeback Studio order — ${order.order_reference}`,
    reply_to: order.customer_email,
    tags: [
      { name: "type", value: "evidencelane-paid-order" },
      { name: "source", value: "stripe-webhook" },
    ],
    html: `
      <h1>New paid Chargeback Studio order</h1>
      <p><strong>Order reference:</strong> ${escapeHtml(order.order_reference)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.customer_email)}</p>
      <p><strong>Payment:</strong> ${escapeHtml(amount)}</p>
      <p><strong>Tier:</strong> ${escapeHtml(order.tier_code)}</p>
      <p><strong>Batch:</strong> ${order.case_count} case${order.case_count === 1 ? "" : "s"} · ${order.file_count} file${order.file_count === 1 ? "" : "s"}</p>
      <p>The signed Stripe event unlocked clean local export for this batch.</p>
    `,
    text: [
      "New paid Chargeback Studio order",
      "",
      `Order reference: ${order.order_reference}`,
      `Customer: ${order.customer_email}`,
      `Payment: ${amount}`,
      `Tier: ${order.tier_code}`,
      `Batch: ${order.case_count} case(s), ${order.file_count} file(s)`,
      "",
      "The signed Stripe event unlocked clean local export for this batch.",
    ].join("\n"),
  };
}

function buildStoredAdminEmail(application) {
  return buildAdminEmail({
    firstName: application.first_name,
    email: application.email,
    googlePlayEmail: application.google_play_email,
    state: application.state,
    androidDevice: application.android_device,
    deliveryPlatforms: application.delivery_platforms || [],
    weeklyDeliveries: application.weekly_deliveries,
    interestReason: application.interest_reason,
  });
}

function buildStoredApplicantEmail(application) {
  return buildApplicantEmail({
    firstName: application.first_name,
    email: application.email,
    googlePlayEmail: application.google_play_email,
  });
}

function buildInviteEmail(application, inviteUrl) {
  return {
    from: BETA_FROM_EMAIL,
    to: [application.email],
    subject: "Your CourierIQ private beta invitation",
    reply_to: BETA_NOTIFICATION_TO,
    tags: [
      { name: "type", value: "beta-invitation" },
      { name: "source", value: "idi-admin" },
    ],
    html: `
      <h1>Welcome to the CourierIQ private beta.</h1>
      <p>Hi ${escapeHtml(application.first_name)},</p>
      <p>Your CourierIQ private beta request has been approved.</p>
      <p>Your authorized Google Play account is <strong>${escapeHtml(application.google_play_email)}</strong>.</p>
      <p>Open the invitation while signed in to that Google account:</p>
      <p><a href="${escapeHtml(inviteUrl)}">Open your beta invitation</a></p>
      <p>This invitation is intended for you. Please do not redistribute the access link.</p>
      <p>— Intelligent Decisions Interactive<br>Clarity over Complexity.</p>
    `,
    text: [
      `Hi ${application.first_name},`,
      "",
      "Your CourierIQ private beta request has been approved.",
      "",
      `Authorized Google Play account: ${application.google_play_email}`,
      "Open the invitation while signed in to that Google account.",
      "",
      `Open your beta invitation: ${inviteUrl}`,
      "",
      "This invitation is intended for you. Please do not redistribute the access link.",
      "",
      "— Intelligent Decisions Interactive",
      "Clarity over Complexity.",
    ].join("\n"),
  };
}

async function processAdminNotification(application, storedApplication, env) {
  if (storedApplication.admin_email_status === "sent") return;

  try {
    const resendId = await sendResendEmail(
      buildAdminEmail(application),
      `beta-admin/${storedApplication.id}`,
      env,
    );
    await updateApplication(
      storedApplication.id,
      {
        admin_email_status: "sent",
        admin_resend_id: resendId,
        last_email_error: null,
      },
      env,
    );
  } catch (error) {
    console.error("Admin beta email failed", error);
    try {
      await updateApplication(
        storedApplication.id,
        {
          admin_email_status: "failed",
          last_email_error: String(error).slice(0, 1000),
        },
        env,
      );
    } catch (updateError) {
      console.error("Admin email failure status update failed", updateError);
    }
  }
}

async function processApplicantConfirmation(application, storedApplication, env) {
  if (storedApplication.applicant_email_status === "sent") return;

  try {
    const resendId = await sendResendEmail(
      buildApplicantEmail(application),
      `beta-applicant/${storedApplication.id}`,
      env,
    );
    await updateApplication(
      storedApplication.id,
      {
        applicant_email_status: "sent",
        applicant_resend_id: resendId,
        last_email_error: null,
      },
      env,
    );
  } catch (error) {
    console.error("Applicant beta email failed", error);
    try {
      await updateApplication(
        storedApplication.id,
        {
          applicant_email_status: "failed",
          last_email_error: String(error).slice(0, 1000),
        },
        env,
      );
    } catch (updateError) {
      console.error("Applicant email failure status update failed", updateError);
    }
  }
}

async function readJsonRequest(request, maxLength = 20000) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { response: jsonResponse({ success: false, message: "Request must use JSON." }, 415) };
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxLength) {
    return { response: jsonResponse({ success: false, message: "Request is too large." }, 413) };
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return { response: jsonResponse({ success: false, message: "Request could not be read." }, 400) };
  }

  if (rawBody.length > maxLength) {
    return { response: jsonResponse({ success: false, message: "Request is too large." }, 413) };
  }

  try {
    return { payload: JSON.parse(rawBody || "{}") };
  } catch {
    return { response: jsonResponse({ success: false, message: "Request contains invalid JSON." }, 400) };
  }
}

async function handleStripePaymentConfig(request, env) {
  const corsHeaders = evidenceLaneCorsHeaders(request, env);
  if (request.method === "OPTIONS") {
    if (!isAllowedCheckoutOrigin(request, env)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
      { ...corsHeaders, Allow: "GET, OPTIONS" },
    );
  }
  if (!isAllowedCheckoutOrigin(request, env)) {
    return jsonResponse(
      { success: false, message: "Request origin is not allowed." },
      403,
      corsHeaders,
    );
  }

  const publishableMode = stripeKeyMode(env.STRIPE_PUBLISHABLE_KEY);
  const secretMode = stripeKeyMode(env.STRIPE_SECRET_KEY);
  if (
    publishableMode === "unknown" ||
    secretMode === "unknown" ||
    publishableMode !== secretMode ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SECRET_KEY
  ) {
    console.error("Stripe Payment Element is missing matching publishable and secret keys.");
    return jsonResponse(
      { success: false, message: "Payment is temporarily unavailable." },
      503,
      corsHeaders,
    );
  }

  let user;
  try {
    user = await authenticateChargebackUser(request, env);
  } catch (error) {
    console.error("Chargeback Studio authentication failed", error);
    return jsonResponse({ success: false, message: "Account verification is temporarily unavailable." }, 503, corsHeaders);
  }
  if (!user) {
    return jsonResponse({ success: false, message: "Sign in before entering payment details." }, 401, corsHeaders);
  }

  return jsonResponse(
    {
      success: true,
      publishableKey: cleanString(env.STRIPE_PUBLISHABLE_KEY, 255),
      currency: "usd",
      livemode: secretMode === "live",
    },
    200,
    corsHeaders,
  );
}

async function handleStripePaymentIntent(request, env) {
  const corsHeaders = evidenceLaneCorsHeaders(request, env);
  if (request.method === "OPTIONS") {
    if (!isAllowedCheckoutOrigin(request, env)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
      { ...corsHeaders, Allow: "POST, OPTIONS" },
    );
  }
  if (!isAllowedCheckoutOrigin(request, env)) {
    return jsonResponse(
      { success: false, message: "Request origin is not allowed." },
      403,
      corsHeaders,
    );
  }

  const publishableMode = stripeKeyMode(env.STRIPE_PUBLISHABLE_KEY);
  const secretMode = stripeKeyMode(env.STRIPE_SECRET_KEY);
  if (
    publishableMode === "unknown" ||
    secretMode === "unknown" ||
    publishableMode !== secretMode ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SECRET_KEY
  ) {
    console.error("Stripe PaymentIntent endpoint is missing matching required bindings.");
    return jsonResponse(
      { success: false, message: "Payment is temporarily unavailable." },
      503,
      corsHeaders,
    );
  }

  let user;
  try {
    user = await authenticateChargebackUser(request, env);
  } catch (error) {
    console.error("Chargeback Studio authentication failed", error);
    return jsonResponse({ success: false, message: "Account verification is temporarily unavailable." }, 503, corsHeaders);
  }
  if (!user) {
    return jsonResponse({ success: false, message: "Sign in before entering payment details." }, 401, corsHeaders);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, message: "Payment details are invalid." }, 400, corsHeaders);
  }

  const packId = cleanString(payload?.pack_id || payload?.batch_id, 80);
  const requestedTierCode = cleanString(payload?.tier, 30);
  const requestedCaseCount = Number(payload?.case_count);
  const requestedFileCount = Number(payload?.file_count);
  const billingAddress = normalizeBillingAddress(payload?.billing_address);
  const billingName = cleanString(payload?.billing_name, 160);
  if (!/^[0-9a-f-]{36}$/i.test(packId)) {
    return jsonResponse({ success: false, message: "Payment details are invalid." }, 400, corsHeaders);
  }
  if (!billingAddress) {
    return jsonResponse({ success: false, message: "Enter a complete billing address." }, 400, corsHeaders);
  }

  let packContext;
  try {
    packContext = await getChargebackPackContext(packId, user.id, env);
  } catch (error) {
    console.error("Chargeback Studio pack validation failed", error);
    return jsonResponse({ success: false, message: "The response pack could not be verified." }, 503, corsHeaders);
  }
  if (!packContext) {
    return jsonResponse({ success: false, message: "Response pack not found." }, 404, corsHeaders);
  }
  if (packContext.pack.status === "unlocked") {
    return jsonResponse({ success: false, message: "This response pack is already unlocked." }, 409, corsHeaders);
  }

  const caseCount = Math.max(
    packContext.caseCount,
    Number.isInteger(requestedCaseCount) && requestedCaseCount >= 0 ? requestedCaseCount : 0,
  );
  const fileCount = Math.max(
    packContext.fileCount,
    Number.isInteger(requestedFileCount) && requestedFileCount >= 0 ? requestedFileCount : 0,
  );
  const minimumTier = resolveEvidenceLaneTier(caseCount, fileCount);
  if (!minimumTier) {
    return jsonResponse(
      { success: false, message: "This volume requires a Chargeback Studio subscription." },
      422,
      corsHeaders,
    );
  }
  const requestedTier = Object.hasOwn(EVIDENCELANE_TIERS, requestedTierCode)
    ? EVIDENCELANE_TIERS[requestedTierCode]
    : null;
  const tier = requestedTier && caseCount <= requestedTier.maxCases && fileCount <= requestedTier.maxFiles
    ? requestedTier
    : minimumTier;

  const previousPaymentIntentId = cleanString(packContext.pack.stripe_payment_intent_id, 255);
  let existingPaymentIntent = null;
  if (previousPaymentIntentId) {
    try {
      existingPaymentIntent = await stripeApiGet(
        `/payment_intents/${encodeURIComponent(previousPaymentIntentId)}`,
        env,
      );
      if (
        existingPaymentIntent?.object === "payment_intent" &&
        existingPaymentIntent.status === "succeeded" &&
        cleanString(existingPaymentIntent.metadata?.pack_id, 80) === packId &&
        cleanString(existingPaymentIntent.metadata?.user_id, 80) === user.id
      ) {
        await updateChargebackPack(packId, {
          status: "unlocked",
          tier_code: cleanString(existingPaymentIntent.metadata?.tier_code, 30) || tier.code,
          case_count: caseCount,
          file_count: fileCount,
          stripe_payment_intent_id: existingPaymentIntent.id,
          unlocked_at: new Date().toISOString(),
        }, env);
        return jsonResponse(
          { success: false, message: "This response pack is already unlocked." },
          409,
          corsHeaders,
        );
      }
      if (["processing", "requires_action", "requires_capture"].includes(existingPaymentIntent?.status)) {
        return jsonResponse(
          { success: false, message: "This payment is already being processed." },
          409,
          corsHeaders,
        );
      }
    } catch (error) {
      console.warn("Existing Chargeback Studio PaymentIntent could not be reused", error);
      existingPaymentIntent = null;
    }
  }

  const addressFingerprint = await sha256Hex(JSON.stringify(billingAddress));
  const attemptSeed = existingPaymentIntent?.status === "canceled"
    ? existingPaymentIntent.id
    : "initial";
  const requestFingerprint = await sha256Hex(
    `${packId}:${tier.code}:${caseCount}:${fileCount}:${addressFingerprint}:${attemptSeed}`,
  );
  const orderReference = `CS-${packId.slice(0, 8)}-${requestFingerprint.slice(0, 10)}`.toUpperCase();
  const taxParameters = new URLSearchParams({
    currency: "usd",
    "line_items[0][amount]": String(tier.amount),
    "line_items[0][reference]": orderReference,
    "line_items[0][tax_behavior]": "exclusive",
    "customer_details[address][postal_code]": billingAddress.postalCode,
    "customer_details[address][country]": billingAddress.country,
    "customer_details[address_source]": "billing",
  });
  if (billingAddress.line1) taxParameters.set("customer_details[address][line1]", billingAddress.line1);
  if (billingAddress.line2) taxParameters.set("customer_details[address][line2]", billingAddress.line2);
  if (billingAddress.city) taxParameters.set("customer_details[address][city]", billingAddress.city);
  if (billingAddress.state) taxParameters.set("customer_details[address][state]", billingAddress.state);
  const taxCode = cleanString(env.STRIPE_CHARGEBACK_TAX_CODE, 40);
  if (taxCode) taxParameters.set("line_items[0][tax_code]", taxCode);

  let taxCalculation;
  try {
    taxCalculation = await stripeApiRequest(
      "/tax/calculations",
      taxParameters,
      `chargeback-tax-${requestFingerprint}`,
      env,
    );
  } catch (error) {
    console.error("Chargeback Studio tax calculation failed", error);
    const message = error?.stripeCode === "customer_tax_location_invalid"
      ? "Stripe could not verify that billing address. Check it and try again."
      : "Tax calculation is temporarily unavailable.";
    return jsonResponse({ success: false, message }, 503, corsHeaders);
  }

  if (!Number.isInteger(taxCalculation?.amount_total) || taxCalculation.amount_total < tier.amount) {
    console.error("Stripe returned an invalid Chargeback Studio tax total.");
    return jsonResponse({ success: false, message: "Tax calculation is temporarily unavailable." }, 503, corsHeaders);
  }

  const paymentParameters = new URLSearchParams({
    amount: String(taxCalculation.amount_total),
    receipt_email: cleanString(user.email, 254),
    description: `Chargeback Studio — ${tier.label} response pack`,
    "hooks[inputs][tax][calculation]": cleanString(taxCalculation.id, 255),
    "metadata[offer_code]": tier.offerCode,
    "metadata[tier_code]": tier.code,
    "metadata[order_reference]": orderReference,
    "metadata[batch_id]": packId,
    "metadata[pack_id]": packId,
    "metadata[organization_id]": packContext.pack.organization_id,
    "metadata[user_id]": user.id,
    "metadata[case_count]": String(caseCount),
    "metadata[file_count]": String(fileCount),
    "metadata[amount_subtotal]": String(tier.amount),
    "metadata[amount_tax]": String(taxCalculation.tax_amount_exclusive || 0),
    "metadata[tax_calculation_id]": cleanString(taxCalculation.id, 255),
    "metadata[address_fingerprint]": addressFingerprint,
    "metadata[customer_email]": cleanString(user.email, 254),
  });
  if (billingName) paymentParameters.set("metadata[billing_name]", billingName);

  try {
    let paymentIntent;
    if (
      existingPaymentIntent?.object === "payment_intent" &&
      ["requires_payment_method", "requires_confirmation"].includes(existingPaymentIntent.status)
    ) {
      paymentIntent = await stripeApiRequest(
        `/payment_intents/${encodeURIComponent(existingPaymentIntent.id)}`,
        paymentParameters,
        `chargeback-payment-update-${existingPaymentIntent.id}-${requestFingerprint}`,
        env,
      );
    } else {
      paymentParameters.set("currency", "usd");
      paymentParameters.set("automatic_payment_methods[enabled]", "true");
      paymentIntent = await stripeApiRequest(
        "/payment_intents",
        paymentParameters,
        `chargeback-payment-create-${requestFingerprint}`,
        env,
      );
    }
    if (!paymentIntent?.id || !paymentIntent?.client_secret) {
      throw new Error("Stripe did not return a usable PaymentIntent.");
    }
    if ((paymentIntent.livemode === true) !== (secretMode === "live")) {
      throw new Error("Stripe key modes do not match the PaymentIntent mode.");
    }
    await updateChargebackPack(packId, {
      status: "payment_pending",
      tier_code: tier.code,
      case_count: caseCount,
      file_count: fileCount,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: paymentIntent.id,
    }, env);
    return jsonResponse(
      {
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amountSubtotal: tier.amount,
        amountTax: Number(taxCalculation.tax_amount_exclusive || 0),
        amountTotal: taxCalculation.amount_total,
        currency: "usd",
        livemode: paymentIntent.livemode === true,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    console.error("Chargeback Studio PaymentIntent creation failed", error);
    return jsonResponse({ success: false, message: "Payment is temporarily unavailable." }, 503, corsHeaders);
  }
}

async function handleStripeEntitlement(request, env) {
  const corsHeaders = evidenceLaneCorsHeaders(request, env);
  if (request.method === "OPTIONS") {
    if (!isAllowedCheckoutOrigin(request, env)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
      { ...corsHeaders, Allow: "GET, OPTIONS" },
    );
  }
  if (!isAllowedCheckoutOrigin(request, env)) {
    return jsonResponse(
      { success: false, message: "Request origin is not allowed." },
      403,
      corsHeaders,
    );
  }
  if (!env.STRIPE_SECRET_KEY || !evidenceLaneOrigin(env)) {
    return jsonResponse(
      { success: false, message: "Payment verification is temporarily unavailable." },
      503,
      corsHeaders,
    );
  }

  let user;
  try {
    user = await authenticateChargebackUser(request, env);
  } catch (error) {
    console.error("Chargeback Studio entitlement authentication failed", error);
    return jsonResponse(
      { success: false, message: "Account verification is temporarily unavailable." },
      503,
      corsHeaders,
    );
  }
  if (!user) {
    return jsonResponse(
      { success: false, message: "Sign in to verify this purchase." },
      401,
      corsHeaders,
    );
  }

  const requestUrl = new URL(request.url);
  const paymentIntentId = cleanString(requestUrl.searchParams.get("payment_intent_id"), 255);
  const sessionId = cleanString(requestUrl.searchParams.get("session_id"), 255);
  const usesPaymentIntent = /^pi_[A-Za-z0-9_]+$/.test(paymentIntentId);
  const usesLegacySession = /^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId);
  if (!usesPaymentIntent && !usesLegacySession) {
    return jsonResponse(
      { success: false, message: "Payment reference is invalid." },
      400,
      corsHeaders,
    );
  }

  try {
    const paymentObject = await stripeApiGet(
      usesPaymentIntent
        ? `/payment_intents/${encodeURIComponent(paymentIntentId)}`
        : `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      env,
    );
    const tier = evidenceLaneTierFromOfferCode(
      cleanString(paymentObject.metadata?.offer_code, 80),
    );
    const batchId = cleanString(paymentObject.metadata?.batch_id, 80);
    const packId = cleanString(paymentObject.metadata?.pack_id || batchId, 80);
    const purchaserId = cleanString(paymentObject.metadata?.user_id, 80);
    if (!tier || !/^[0-9a-f-]{36}$/i.test(packId) || purchaserId !== user.id) {
      return jsonResponse(
        { success: false, message: "Payment is not available to this account." },
        404,
        corsHeaders,
      );
    }

    const packContext = await getChargebackPackContext(packId, user.id, env);
    if (!packContext || packContext.pack.organization_id !== paymentObject.metadata?.organization_id) {
      return jsonResponse(
        { success: false, message: "Response pack not found." },
        404,
        corsHeaders,
      );
    }

    const unlocked = usesPaymentIntent
      ? paymentObject.status === "succeeded"
      : paymentObject.status === "complete" && paymentObject.payment_status === "paid";
    if (unlocked) {
      const packUpdate = {
        status: "unlocked",
        tier_code: tier.code,
        case_count: packContext.caseCount,
        file_count: packContext.fileCount,
        unlocked_at: new Date().toISOString(),
      };
      if (usesPaymentIntent) {
        packUpdate.stripe_payment_intent_id = paymentObject.id;
      } else {
        packUpdate.stripe_checkout_session_id = paymentObject.id;
      }
      await updateChargebackPack(packId, packUpdate, env);
    }
    return jsonResponse(
      {
        success: true,
        unlocked,
        batchId: packId,
        packId,
        tierCode: tier.code,
        tierLabel: tier.label,
        maxCases: tier.maxCases,
        maxFiles: tier.maxFiles,
        orderReference: cleanString(
          paymentObject.metadata?.order_reference || paymentObject.client_reference_id,
          80,
        ),
        paymentIntentId: usesPaymentIntent ? paymentObject.id : null,
      },
      unlocked ? 200 : 409,
      corsHeaders,
    );
  } catch (error) {
    console.error("Chargeback Studio entitlement verification failed", error);
    return jsonResponse(
      { success: false, message: "Payment could not be verified." },
      503,
      corsHeaders,
    );
  }
}

async function handleStripeWebhook(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
      { Allow: "POST" },
    );
  }

  const requiredBindings = [
    "STRIPE_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "RESEND_API_KEY",
    "EVIDENCELANE_ORIGIN",
  ];
  if (requiredBindings.some((binding) => !env[binding])) {
    console.error("Stripe webhook endpoint is missing required bindings.");
    return jsonResponse({ success: false }, 503);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 1_000_000) {
    return jsonResponse({ success: false }, 413);
  }

  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) {
    return jsonResponse({ success: false }, 413);
  }

  const verified = await verifyStripeSignature(
    rawBody,
    request.headers.get("Stripe-Signature"),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!verified) {
    return jsonResponse({ success: false }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ success: false }, 400);
  }

  if (isRevenueLeakStripeEvent(event)) {
    try {
      await fulfillRevenueLeakStripeEvent(event, env);
      return jsonResponse({ received: true });
    } catch (error) {
      console.error("Revenue Leak Finder Stripe webhook processing failed", error);
      return jsonResponse({ success: false }, 500);
    }
  }

  if (isBidLensStripeEvent(event)) {
    try {
      await fulfillBidLensStripeEvent(event, env);
      return jsonResponse({ received: true });
    } catch (error) {
      console.error("BidLens Stripe webhook processing failed", error);
      return jsonResponse({ success: false }, 500);
    }
  }

  if (isScopeFenceStripeEvent(event)) {
    try {
      await fulfillScopeFenceStripeEvent(event, env);
      return jsonResponse({ received: true });
    } catch (error) {
      console.error("ScopeFence Stripe webhook processing failed", error);
      return jsonResponse({ success: false }, 500);
    }
  }

  if (!event?.id || !event?.type || !EVIDENCELANE_STRIPE_EVENTS.has(event.type)) {
    return jsonResponse({ received: true });
  }

  const paymentObject = event.data?.object;
  if (
    !["checkout.session", "payment_intent"].includes(paymentObject?.object) ||
    !EVIDENCELANE_OFFER_CODES.has(paymentObject.metadata?.offer_code)
  ) {
    return jsonResponse({ received: true });
  }

  try {
    if (await hasProcessedStripeEvent(event.id, env)) {
      return jsonResponse({ received: true, duplicate: true });
    }

    const order = await upsertEvidenceLaneOrder(paymentObject, event.type, env);
    const paid = paymentObject.object === "payment_intent"
      ? paymentObject.status === "succeeded"
      : paymentObject.payment_status === "paid";
    if (paid) {
      const packId = cleanString(
        paymentObject.metadata?.pack_id || paymentObject.metadata?.batch_id,
        80,
      );
      if (/^[0-9a-f-]{36}$/i.test(packId)) {
        const packUpdate = {
          status: "unlocked",
          tier_code: cleanString(paymentObject.metadata?.tier_code, 30),
          case_count: Number(paymentObject.metadata?.case_count),
          file_count: Number(paymentObject.metadata?.file_count),
          unlocked_at: new Date().toISOString(),
        };
        if (paymentObject.object === "payment_intent") {
          packUpdate.stripe_checkout_session_id = null;
          packUpdate.stripe_payment_intent_id = paymentObject.id;
        } else {
          packUpdate.stripe_checkout_session_id = paymentObject.id;
        }
        await updateChargebackPack(packId, packUpdate, env);
      }
      const notifications = [
        sendResendEmail(
          buildEvidenceLaneAdminEmail(order),
          `chargeback-studio-admin-${paymentObject.id}`,
          env,
        ),
      ];
      if (order.customer_email) {
        notifications.push(
          sendResendEmail(
            buildEvidenceLaneCustomerEmail(order, env),
            `chargeback-studio-customer-${paymentObject.id}`,
            env,
          ),
        );
      }
      await Promise.all(notifications);
    }

    await insertStripeWebhookEvent(event, paymentObject.id, env);
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    return jsonResponse({ success: false }, 500);
  }
}

async function handleBetaAccess(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, message: "Method not allowed." },
      405,
      { Allow: "POST" },
    );
  }
  if (!isAllowedOrigin(request)) {
    return jsonResponse(
      { success: false, message: "Request origin is not allowed." },
      403,
    );
  }

  const requiredBindings = [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "RESEND_API_KEY",
    "TURNSTILE_SECRET_KEY",
  ];
  if (requiredBindings.some((binding) => !env[binding])) {
    console.error("Beta access endpoint is missing required bindings.");
    return jsonResponse(
      {
        success: false,
        message: "Beta access is temporarily unavailable. Please try again later.",
      },
      503,
    );
  }

  const parsed = await readJsonRequest(request);
  if (parsed.response) return parsed.response;
  const validation = validateSubmission(parsed.payload);

  // Quietly accept honeypot submissions without storing or sending anything.
  if (validation.honeypot) {
    return jsonResponse({
      success: true,
      message: "Your CourierIQ beta request has been received.",
    });
  }
  if (validation.error) {
    return jsonResponse({ success: false, message: validation.error }, 400);
  }

  const turnstile = await verifyTurnstile(
    validation.data.turnstileToken,
    request,
    env,
  );
  if (turnstile.serviceError) {
    return jsonResponse(
      {
        success: false,
        message: "Verification is temporarily unavailable. Please try again.",
      },
      503,
    );
  }
  if (!turnstile.success) {
    return jsonResponse(
      {
        success: false,
        message: "Verification failed or expired. Please complete it again.",
      },
      403,
    );
  }

  let storedApplication;
  try {
    storedApplication = await upsertApplication(validation.data, env);
  } catch (error) {
    console.error("Beta application storage failed", error);
    return jsonResponse(
      {
        success: false,
        message: "Your request could not be saved. Please try again.",
      },
      503,
    );
  }

  // Storage is authoritative. Email failures are recorded for retry without
  // causing a valid application to be lost or shown as failed to the user.
  await processAdminNotification(validation.data, storedApplication, env);
  await processApplicantConfirmation(validation.data, storedApplication, env);

  return jsonResponse({
    success: true,
    message: "Your CourierIQ beta request has been received.",
  });
}

async function handleAdminList(request, env, actorEmail) {
  if (request.method !== "GET") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405, { Allow: "GET" });
  }
  const url = new URL(request.url);
  const status = cleanString(url.searchParams.get("status"), 20).toLowerCase();

  try {
    const applications = await listApplications(status, env);
    return jsonResponse({
      success: true,
      actorEmail,
      inviteEnabled: Boolean(env.BETA_INVITE_URL),
      applications,
    });
  } catch (error) {
    console.error("Admin list failed", error);
    return jsonResponse({ success: false, message: "Applications could not be loaded." }, 503);
  }
}

async function handleAdminDetail(request, env, actorEmail, applicationId) {
  if (request.method !== "GET") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405, { Allow: "GET" });
  }

  try {
    const [application, events] = await Promise.all([
      getApplication(applicationId, env),
      listEvents(applicationId, env),
    ]);
    if (!application) {
      return jsonResponse({ success: false, message: "Application not found." }, 404);
    }
    return jsonResponse({
      success: true,
      actorEmail,
      inviteEnabled: Boolean(env.BETA_INVITE_URL),
      application,
      events,
    });
  } catch (error) {
    console.error("Admin detail failed", error);
    return jsonResponse({ success: false, message: "Application details could not be loaded." }, 503);
  }
}

async function handleAdminUpdate(request, env, actorEmail, applicationId) {
  if (request.method !== "PATCH") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405, { Allow: "PATCH" });
  }
  if (!isAllowedOrigin(request)) {
    return jsonResponse({ success: false, message: "Request origin is not allowed." }, 403);
  }

  const parsed = await readJsonRequest(request, 12000);
  if (parsed.response) return parsed.response;

  const current = await getApplication(applicationId, env);
  if (!current) {
    return jsonResponse({ success: false, message: "Application not found." }, 404);
  }

  const changes = {};
  const events = [];
  if (Object.prototype.hasOwnProperty.call(parsed.payload, "status")) {
    const status = cleanString(parsed.payload.status, 20).toLowerCase();
    if (!ALLOWED_STATUSES.has(status)) {
      return jsonResponse({ success: false, message: "Invalid application status." }, 400);
    }
    if (status !== current.status) {
      changes.status = status;
      changes.reviewed_at = new Date().toISOString();
      changes.reviewed_by = actorEmail;
      events.push({
        request_id: applicationId,
        event_type: "status_changed",
        actor_email: actorEmail,
        previous_status: current.status,
        new_status: status,
        details: {},
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed.payload, "admin_notes")) {
    const adminNotes = cleanString(parsed.payload.admin_notes, 5000);
    if (adminNotes !== (current.admin_notes || "")) {
      changes.admin_notes = adminNotes || null;
      events.push({
        request_id: applicationId,
        event_type: "notes_updated",
        actor_email: actorEmail,
        previous_status: current.status,
        new_status: changes.status || current.status,
        details: { note_length: adminNotes.length },
      });
    }
  }

  if (!Object.keys(changes).length) {
    return jsonResponse({ success: true, application: current, events: await listEvents(applicationId, env) });
  }

  try {
    const updated = await updateApplication(
      applicationId,
      changes,
      env,
      ADMIN_REQUEST_SELECT,
    );
    for (const event of events) {
      await insertEvent(event, env);
    }
    return jsonResponse({
      success: true,
      application: updated,
      events: await listEvents(applicationId, env),
    });
  } catch (error) {
    console.error("Admin update failed", error);
    return jsonResponse({ success: false, message: "Application could not be updated." }, 503);
  }
}

async function handleAdminRetry(request, env, actorEmail, applicationId) {
  if (request.method !== "POST") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405, { Allow: "POST" });
  }
  if (!isAllowedOrigin(request)) {
    return jsonResponse({ success: false, message: "Request origin is not allowed." }, 403);
  }

  const parsed = await readJsonRequest(request, 2000);
  if (parsed.response) return parsed.response;
  const type = cleanString(parsed.payload.type, 30);
  if (!new Set(["admin", "applicant"]).has(type)) {
    return jsonResponse({ success: false, message: "Invalid email retry type." }, 400);
  }

  const application = await getApplication(applicationId, env);
  if (!application) {
    return jsonResponse({ success: false, message: "Application not found." }, 404);
  }

  try {
    const message = type === "admin"
      ? buildStoredAdminEmail(application)
      : buildStoredApplicantEmail(application);
    const resendId = await sendResendEmail(
      message,
      `beta-retry-${type}/${applicationId}/${crypto.randomUUID()}`,
      env,
    );
    const changes = type === "admin"
      ? {
          admin_email_status: "sent",
          admin_resend_id: resendId,
          last_email_error: null,
        }
      : {
          applicant_email_status: "sent",
          applicant_resend_id: resendId,
          last_email_error: null,
        };
    const updated = await updateApplication(
      applicationId,
      changes,
      env,
      ADMIN_REQUEST_SELECT,
    );
    await insertEvent(
      {
        request_id: applicationId,
        event_type: "email_retried",
        actor_email: actorEmail,
        previous_status: application.status,
        new_status: application.status,
        details: { type, resend_id: resendId },
      },
      env,
    );
    return jsonResponse({
      success: true,
      application: updated,
      events: await listEvents(applicationId, env),
    });
  } catch (error) {
    console.error("Email retry failed", error);
    const changes = type === "admin"
      ? { admin_email_status: "failed", last_email_error: String(error).slice(0, 1000) }
      : { applicant_email_status: "failed", last_email_error: String(error).slice(0, 1000) };
    await updateApplication(applicationId, changes, env).catch(() => {});
    return jsonResponse({ success: false, message: "The email could not be sent." }, 503);
  }
}

async function handleAdminInvite(request, env, actorEmail, applicationId) {
  if (request.method !== "POST") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405, { Allow: "POST" });
  }
  if (!isAllowedOrigin(request)) {
    return jsonResponse({ success: false, message: "Request origin is not allowed." }, 403);
  }
  if (!env.BETA_INVITE_URL) {
    return jsonResponse(
      {
        success: false,
        message: "Invitation delivery is not configured yet.",
      },
      409,
    );
  }

  const application = await getApplication(applicationId, env);
  if (!application) {
    return jsonResponse({ success: false, message: "Application not found." }, 404);
  }
  if (!["approved", "invited"].includes(application.status)) {
    return jsonResponse(
      { success: false, message: "Approve the applicant before sending an invitation." },
      409,
    );
  }
  if (!isValidEmail(application.google_play_email || "")) {
    return jsonResponse(
      {
        success: false,
        message: "A valid Google Play account email is required before inviting this applicant.",
      },
      409,
    );
  }

  try {
    await updateApplication(applicationId, { invite_email_status: "pending" }, env);
    const resendId = await sendResendEmail(
      buildInviteEmail(application, env.BETA_INVITE_URL),
      `beta-invite/${applicationId}/${crypto.randomUUID()}`,
      env,
    );
    const invitedAt = new Date().toISOString();
    const updated = await updateApplication(
      applicationId,
      {
        status: "invited",
        invited_at: invitedAt,
        invite_resend_id: resendId,
        invite_email_status: "sent",
        invite_email_error: null,
        reviewed_at: invitedAt,
        reviewed_by: actorEmail,
      },
      env,
      ADMIN_REQUEST_SELECT,
    );
    await insertEvent(
      {
        request_id: applicationId,
        event_type: "invite_sent",
        actor_email: actorEmail,
        previous_status: application.status,
        new_status: "invited",
        details: { resend_id: resendId },
      },
      env,
    );
    return jsonResponse({
      success: true,
      application: updated,
      events: await listEvents(applicationId, env),
    });
  } catch (error) {
    console.error("Invite failed", error);
    await updateApplication(
      applicationId,
      {
        invite_email_status: "failed",
        invite_email_error: String(error).slice(0, 1000),
      },
      env,
    ).catch(() => {});
    await insertEvent(
      {
        request_id: applicationId,
        event_type: "invite_failed",
        actor_email: actorEmail,
        previous_status: application.status,
        new_status: application.status,
        details: { error: String(error).slice(0, 500) },
      },
      env,
    ).catch(() => {});
    return jsonResponse({ success: false, message: "The invitation could not be sent." }, 503);
  }
}

async function handleAdminApi(request, env, url) {
  const admin = requireAdmin(request);
  if (admin.response) return admin.response;

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/admin/api/requests") {
    return handleAdminList(request, env, admin.email);
  }

  const detailMatch = pathname.match(/^\/admin\/api\/requests\/([0-9a-f-]{36})$/i);
  if (detailMatch) {
    return request.method === "PATCH"
      ? handleAdminUpdate(request, env, admin.email, detailMatch[1])
      : handleAdminDetail(request, env, admin.email, detailMatch[1]);
  }

  const retryMatch = pathname.match(/^\/admin\/api\/requests\/([0-9a-f-]{36})\/retry-email$/i);
  if (retryMatch) {
    return handleAdminRetry(request, env, admin.email, retryMatch[1]);
  }

  const inviteMatch = pathname.match(/^\/admin\/api\/requests\/([0-9a-f-]{36})\/invite$/i);
  if (inviteMatch) {
    return handleAdminInvite(request, env, admin.email, inviteMatch[1]);
  }

  return jsonResponse({ success: false, message: "Admin API route not found." }, 404);
}

async function routeRequest(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname === "/projects/evidencelane" ||
      url.pathname === "/projects/evidencelane/"
    ) {
      url.pathname = "/projects/chargeback-studio/";
      return Response.redirect(url.toString(), 308);
    }

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return jsonResponse(
          { success: false, message: "Method not allowed." },
          405,
          { Allow: "GET" },
        );
      }
      return jsonResponse({
        success: true,
        status: "ok",
      });
    }

    if (url.pathname === "/api/beta-access") {
      return handleBetaAccess(request, env);
    }

    if (url.pathname.startsWith("/api/revenue-leak-finder/")) {
      return handleRevenueLeakApi(request, env, url);
    }

    if (url.pathname.startsWith("/api/bidlens/")) {
      return handleBidLensApi(request, env, url);
    }

    if (url.pathname.startsWith("/api/scopefence/")) {
      return handleScopeFenceApi(request, env, url);
    }

    if (url.pathname === "/api/stripe/payment-config") {
      return handleStripePaymentConfig(request, env);
    }

    if (url.pathname === "/api/stripe/payment-intent") {
      return handleStripePaymentIntent(request, env);
    }

    if (url.pathname === "/api/stripe/checkout-session") {
      return jsonResponse(
        { success: false, message: "Hosted checkout has been retired." },
        410,
      );
    }

    if (url.pathname === "/api/stripe/entitlement") {
      return handleStripeEntitlement(request, env);
    }

    if (url.pathname === "/api/stripe/webhook") {
      return handleStripeWebhook(request, env);
    }

    if (url.pathname.startsWith("/admin/api/")) {
      return handleAdminApi(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ success: false, message: "API route not found." }, 404);
    }

    return env.ASSETS.fetch(request);
}

function contentSecurityPolicy(requestUrl) {
  const scriptSources = ["'self'", "https://challenges.cloudflare.com"];
  const imageSources = ["'self'", "data:"];
  const connectSources = ["'self'", "https://challenges.cloudflare.com"];
  const frameSources = ["https://challenges.cloudflare.com"];

  if (requestUrl.pathname.startsWith("/projects/chargeback-studio/")) {
    scriptSources.push(
      "https://js.stripe.com",
      "https://*.js.stripe.com",
      CHARGEBACK_JSON_LD_HASH,
    );
    imageSources.push("blob:", "https://*.stripe.com");
    connectSources.push(
      SUPABASE_BROWSER_ORIGIN,
      SUPABASE_BROWSER_SOCKET_ORIGIN,
      "https://api.stripe.com",
    );
    frameSources.push(
      "https://js.stripe.com",
      "https://*.js.stripe.com",
      "https://hooks.stripe.com",
    );
  }

  if (requestUrl.pathname.startsWith("/insights/shopify-chargeback-evidence-packet/")) {
    scriptSources.push(INSIGHT_JSON_LD_HASH);
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `img-src ${imageSources.join(" ")}`,
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSources.join(" ")}`,
    `frame-src ${frameSources.join(" ")}`,
    "form-action 'self'",
  ].join("; ");
}

function secureResponse(response, requestUrl) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Content-Security-Policy", contentSecurityPolicy(requestUrl));
  if (requestUrl.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!isLoopback && url.protocol !== "https:") || url.hostname === "www.intelligentdecisions.io") {
      url.protocol = "https:";
      url.hostname = "intelligentdecisions.io";
      return Response.redirect(url.toString(), 308);
    }
    return secureResponse(await routeRequest(request, env), url);
  },
};
