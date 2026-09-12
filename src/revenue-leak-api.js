"use strict";

const ACCESS_COOKIE = "idi_rlf_access";
const REFRESH_COOKIE = "idi_rlf_refresh";
const COOKIE_PATH = "/api/revenue-leak-finder";
const REFRESH_COOKIE_SECONDS = 30 * 24 * 60 * 60;
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const STRIPE_API_ENDPOINT = "https://api.stripe.com/v1";
const REPORT_PACK = Object.freeze({ credits: 10, priceCents: 2900, currency: "usd" });
const REVENUE_LEAK_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

function cleanString(value, maximumLength = 500) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\u0000-\u001f]/g, "").trim().slice(0, maximumLength)
    : "";
}

function jsonResponse(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function sessionCookie(name, value, maxAge, request) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "HttpOnly",
    "SameSite=Strict",
    new URL(request.url).protocol === "https:" ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function appendSessionCookies(headers, session, request) {
  headers.append("Set-Cookie", sessionCookie(ACCESS_COOKIE, session.accessToken, session.expiresIn, request));
  headers.append("Set-Cookie", sessionCookie(REFRESH_COOKIE, session.refreshToken, REFRESH_COOKIE_SECONDS, request));
}

function appendExpiredCookies(headers, request) {
  headers.append("Set-Cookie", sessionCookie(ACCESS_COOKIE, "", 0, request));
  headers.append("Set-Cookie", sessionCookie(REFRESH_COOKIE, "", 0, request));
}

function supabaseBaseUrl(env) {
  return cleanString(env.SUPABASE_URL, 500).replace(/\/+$/, "");
}

function serviceHeaders(env, prefer) {
  const secret = cleanString(env.SUPABASE_SECRET_KEY, 1000);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: secret,
    Authorization: `Bearer ${secret}`,
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function requireConfiguration(env, names) {
  const missing = names.filter((name) => !cleanString(env[name], 4000));
  if (missing.length) throw new Error(`Missing bindings: ${missing.join(", ")}`);
}

async function serviceRequest(path, options, env, prefer) {
  requireConfiguration(env, ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  const response = await fetchWithTimeout(
    `${supabaseBaseUrl(env)}/rest/v1/${path}`,
    { ...options, headers: { ...serviceHeaders(env, prefer), ...(options?.headers || {}) } },
    15000,
  );
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    throw new Error(`Revenue Leak Finder storage failed (${response.status}): ${String(text).slice(0, 300)}`);
  }
  return body;
}

async function rpc(name, payload, env) {
  return serviceRequest(`rpc/${name}`, { method: "POST", body: JSON.stringify(payload) }, env);
}

async function authRequest(path, payload, env, options = {}) {
  requireConfiguration(env, ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
  const key = cleanString(env.SUPABASE_PUBLISHABLE_KEY, 1000);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: key,
    "X-Client-Info": "intelligent-decisions-revenue-leak-finder/1.0",
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.remoteIp) headers["X-Forwarded-For"] = options.remoteIp;
  const response = await fetchWithTimeout(
    `${supabaseBaseUrl(env)}/auth/v1/${path}`,
    {
      method: payload === null ? "GET" : "POST",
      headers,
      body: payload === null ? undefined : JSON.stringify(payload),
    },
  );
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { throw new Error("Authentication returned an invalid response."); }
  }
  if (!response.ok) {
    const error = new Error(cleanString(body?.msg || body?.message, 300) || "Authentication failed.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeSession(body) {
  const accessToken = cleanString(body?.access_token, 8192);
  const refreshToken = cleanString(body?.refresh_token, 8192);
  const expiresIn = Number(body?.expires_in);
  const id = cleanString(body?.user?.id, 80);
  const email = normalizeEmail(body?.user?.email);
  if (!accessToken || !refreshToken || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || !id || !email) {
    throw new Error("Authentication returned an incomplete session.");
  }
  return { accessToken, refreshToken, expiresIn, user: { id, email } };
}

async function getIdentity(request, env) {
  const accessToken = cookieValue(request, ACCESS_COOKIE);
  if (!accessToken) return null;
  try {
    const body = await authRequest("user", null, env, { accessToken });
    const id = cleanString(body?.id, 80);
    const email = normalizeEmail(body?.email);
    return id && email ? { id, email } : null;
  } catch {
    return null;
  }
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : -1;
}

function mapAccount(row) {
  return {
    email: normalizeEmail(row.email),
    reportCredits: Math.max(0, Number(row.report_credits) || 0),
    freeReportsRemaining: Math.max(0, Number(row.free_reports_remaining) || 0),
    reportsCompleted: Math.max(0, Number(row.reports_completed) || 0),
  };
}

async function ensureAccount(identity, env) {
  const rows = await serviceRequest(
    "revenue_leak_accounts?on_conflict=user_id&select=user_id,email,report_credits,free_reports_remaining,reports_completed,created_at,updated_at",
    {
      method: "POST",
      body: JSON.stringify([{ user_id: identity.id, email: identity.email, updated_at: new Date().toISOString() }]),
    },
    env,
    "resolution=merge-duplicates,return=representation",
  );
  if (!Array.isArray(rows) || !rows[0]) throw new Error("Revenue Leak Finder account not found.");
  return mapAccount(rows[0]);
}

async function listHistory(userId, env) {
  const rows = await serviceRequest(
    `revenue_leak_analyses?user_id=eq.${encodeURIComponent(userId)}` +
      "&select=id,analysis_key,left_name,right_name,left_rows,right_rows,issue_count,value_at_risk_cents,summary,created_at&order=created_at.desc&limit=25",
    { method: "GET" },
    env,
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id,
    analysisKey: row.analysis_key,
    leftName: row.left_name,
    rightName: row.right_name,
    leftRows: Number(row.left_rows) || 0,
    rightRows: Number(row.right_rows) || 0,
    issueCount: Number(row.issue_count) || 0,
    valueAtRiskCents: Number(row.value_at_risk_cents) || 0,
    summary: row.summary || {},
    createdAt: row.created_at,
  }));
}

async function readJson(request, maximumBytes = 16384) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Request must use JSON.");
    error.status = 415;
    throw error;
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maximumBytes) {
    const error = new Error("Request is too large.");
    error.status = 413;
    throw error;
  }
  const text = await request.text();
  if (text.length > maximumBytes) {
    const error = new Error("Request is too large.");
    error.status = 413;
    throw error;
  }
  try { return JSON.parse(text); } catch {
    const error = new Error("Request contains invalid JSON.");
    error.status = 400;
    throw error;
  }
}

async function verifyTurnstile(token, request, env) {
  requireConfiguration(env, ["TURNSTILE_SECRET_KEY"]);
  if (!token) return false;
  const response = await fetchWithTimeout(
    TURNSTILE_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: cleanString(request.headers.get("CF-Connecting-IP"), 80),
        idempotency_key: crypto.randomUUID(),
      }),
    },
    8000,
  );
  if (!response.ok) return false;
  const result = await response.json();
  return result?.success === true &&
    result?.action === "revenue_leak_account" &&
    ["intelligentdecisions.io", "www.intelligentdecisions.io"].includes(result?.hostname);
}

async function handleRequestCode(request, env) {
  const body = await readJson(request);
  if (cleanString(body.website, 200)) return jsonResponse({ ok: true });
  const email = normalizeEmail(body.email);
  const token = cleanString(body.turnstileToken, 2048);
  if (!validEmail(email)) return jsonResponse({ error: "Enter a valid email address." }, 400);
  if (!await verifyTurnstile(token, request, env)) {
    return jsonResponse({ error: "Complete the security check and try again." }, 403);
  }
  await authRequest("otp", { email, create_user: true, data: { product: "revenue_leak_finder" } }, env, {
    remoteIp: cleanString(request.headers.get("CF-Connecting-IP"), 80),
  });
  return jsonResponse({ ok: true });
}

async function handleVerifyCode(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const code = cleanString(body.code, 20);
  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return jsonResponse({ error: "Enter the six-digit code from your email." }, 400);
  }
  const session = normalizeSession(await authRequest("verify", { type: "email", email, token: code }, env));
  const account = await ensureAccount(session.user, env);
  const headers = new Headers();
  appendSessionCookies(headers, session, request);
  return jsonResponse({ ok: true, account }, 200, headers);
}

async function handleRefresh(request, env) {
  const refreshToken = cookieValue(request, REFRESH_COOKIE);
  if (!refreshToken) return jsonResponse({ error: "Sign in to continue." }, 401);
  try {
    const session = normalizeSession(await authRequest("token?grant_type=refresh_token", { refresh_token: refreshToken }, env));
    const account = await ensureAccount(session.user, env);
    const headers = new Headers();
    appendSessionCookies(headers, session, request);
    return jsonResponse({ ok: true, account }, 200, headers);
  } catch (error) {
    console.error("Revenue Leak Finder session refresh failed", error);
    const headers = new Headers();
    appendExpiredCookies(headers, request);
    return jsonResponse({ error: "Your session expired. Sign in again." }, 401, headers);
  }
}

async function handleLogout(request, env) {
  const accessToken = cookieValue(request, ACCESS_COOKIE);
  if (accessToken) {
    try { await authRequest("logout?scope=local", {}, env, { accessToken }); } catch (error) {
      console.warn("Revenue Leak Finder logout revoke failed", error);
    }
  }
  const headers = new Headers();
  appendExpiredCookies(headers, request);
  return jsonResponse({ ok: true }, 200, headers);
}

async function handleAccount(request, env) {
  const identity = await getIdentity(request, env);
  if (!identity) return jsonResponse({ error: "Sign in to continue." }, 401);
  const [account, history] = await Promise.all([ensureAccount(identity, env), listHistory(identity.id, env)]);
  return jsonResponse({ ok: true, account, history });
}

function fileName(value) {
  return cleanString(value, 180);
}

async function handleAnalysis(request, env) {
  const identity = await getIdentity(request, env);
  if (!identity) return jsonResponse({ error: "Sign in to run a full report." }, 401);
  await ensureAccount(identity, env);
  const body = await readJson(request);
  const analysisKey = cleanString(body.analysisKey, 80);
  const leftName = fileName(body.leftName);
  const rightName = fileName(body.rightName);
  const leftRows = integer(body.leftRows, 1, 25000);
  const rightRows = integer(body.rightRows, 1, 25000);
  const issueCount = integer(body.issueCount, 0, 100000);
  const valueAtRiskCents = integer(body.valueAtRiskCents, 0, Number.MAX_SAFE_INTEGER);
  const summary = body.summary && typeof body.summary === "object" && !Array.isArray(body.summary) ? body.summary : {};
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(analysisKey) || !leftName || !rightName ||
      [leftRows, rightRows, issueCount, valueAtRiskCents].includes(-1)) {
    return jsonResponse({ error: "The report summary is invalid." }, 400);
  }
  const result = await rpc("revenue_leak_record_analysis", {
    p_user_id: identity.id,
    p_analysis_key: analysisKey,
    p_left_name: leftName,
    p_right_name: rightName,
    p_left_rows: leftRows,
    p_right_rows: rightRows,
    p_issue_count: issueCount,
    p_value_at_risk_cents: valueAtRiskCents,
    p_summary: summary,
  }, env);
  if (!result?.allowed) return jsonResponse({ error: "Add report credits to continue.", account: result?.account }, 402);
  return jsonResponse({ ok: true, used: result.used, account: result.account });
}

async function stripeCheckout(identity, request, env, idempotencyKey) {
  requireConfiguration(env, ["STRIPE_SECRET_KEY"]);
  const origin = new URL(request.url).origin;
  const parameters = new URLSearchParams({
    mode: "payment",
    customer_email: identity.email,
    client_reference_id: identity.id,
    success_url: `${origin}/projects/revenue-leak-finder/?purchase=success`,
    cancel_url: `${origin}/projects/revenue-leak-finder/?purchase=canceled`,
    "automatic_tax[enabled]": "true",
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": REPORT_PACK.currency,
    "line_items[0][price_data][unit_amount]": String(REPORT_PACK.priceCents),
    "line_items[0][price_data][product_data][name]": `${REPORT_PACK.credits} Revenue Leak Finder report credits`,
    "line_items[0][price_data][product_data][description]": "Unlock ten full reconciliations and downloadable exception reports.",
    "metadata[revenue_leak_flow]": "report_credit_pack_v1",
    "metadata[revenue_leak_user_id]": identity.id,
    "metadata[revenue_leak_credits]": String(REPORT_PACK.credits),
    "payment_intent_data[metadata][revenue_leak_flow]": "report_credit_pack_v1",
    "payment_intent_data[metadata][revenue_leak_user_id]": identity.id,
    "payment_intent_data[metadata][revenue_leak_credits]": String(REPORT_PACK.credits),
  });
  const response = await fetchWithTimeout(`${STRIPE_API_ENDPOINT}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `revenue-leak:${identity.id}:${idempotencyKey}`,
      "Stripe-Version": "2025-06-30.basil",
    },
    body: parameters.toString(),
  }, 15000);
  let body = {};
  try { body = await response.json(); } catch { throw new Error("Stripe returned an invalid response."); }
  if (!response.ok) throw new Error(`Stripe checkout failed (${response.status}).`);
  const id = cleanString(body.id, 255);
  const url = cleanString(body.url, 2000);
  if (body.object !== "checkout.session" || !id.startsWith("cs_") || !url.startsWith("https://checkout.stripe.com/")) {
    throw new Error("Stripe returned an invalid checkout session.");
  }
  return { id, url };
}

async function handleCheckout(request, env) {
  const identity = await getIdentity(request, env);
  if (!identity) return jsonResponse({ error: "Sign in before adding report credits." }, 401);
  await ensureAccount(identity, env);
  const body = await readJson(request);
  const idempotencyKey = cleanString(body.idempotencyKey, 80);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(idempotencyKey)) {
    return jsonResponse({ error: "Invalid purchase request." }, 400);
  }
  const checkout = await stripeCheckout(identity, request, env, idempotencyKey);
  return jsonResponse({ ok: true, url: checkout.url });
}

export async function handleRevenueLeakApi(request, env, url) {
  const pathname = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  const mutation = method !== "GET" && method !== "HEAD";
  if (mutation && !sameOrigin(request)) return jsonResponse({ error: "Invalid request origin." }, 403);
  const expectedMethod = pathname === "/api/revenue-leak-finder/account" ? "GET" : "POST";
  if (method !== expectedMethod) return jsonResponse({ error: "Method not allowed." }, 405, { Allow: expectedMethod });
  try {
    if (pathname === "/api/revenue-leak-finder/account") return handleAccount(request, env);
    if (pathname === "/api/revenue-leak-finder/auth/request-code") return handleRequestCode(request, env);
    if (pathname === "/api/revenue-leak-finder/auth/verify-code") return handleVerifyCode(request, env);
    if (pathname === "/api/revenue-leak-finder/auth/refresh") return handleRefresh(request, env);
    if (pathname === "/api/revenue-leak-finder/auth/logout") return handleLogout(request, env);
    if (pathname === "/api/revenue-leak-finder/analyses") return handleAnalysis(request, env);
    if (pathname === "/api/revenue-leak-finder/checkout") return handleCheckout(request, env);
    return jsonResponse({ error: "API route not found." }, 404);
  } catch (error) {
    console.error("Revenue Leak Finder API failed", pathname, error);
    const status = Number(error?.status);
    if (status === 429) return jsonResponse({ error: "Wait a moment before trying again." }, 429);
    if ([400, 413, 415].includes(status)) return jsonResponse({ error: error.message }, status);
    return jsonResponse({ error: "The request could not be completed right now." }, 503);
  }
}

export function isRevenueLeakStripeEvent(event) {
  return REVENUE_LEAK_STRIPE_EVENTS.has(event?.type) &&
    event?.data?.object?.object === "checkout.session" &&
    event?.data?.object?.metadata?.revenue_leak_flow === "report_credit_pack_v1";
}

export async function fulfillRevenueLeakStripeEvent(event, env) {
  if (!isRevenueLeakStripeEvent(event)) return false;
  const session = event.data.object;
  if (event.type === "checkout.session.async_payment_failed" || session.payment_status !== "paid") return true;
  const userId = cleanString(session.metadata?.revenue_leak_user_id || session.client_reference_id, 80);
  const credits = Number(session.metadata?.revenue_leak_credits);
  const subtotal = Number(session.amount_subtotal);
  const total = Number(session.amount_total);
  const currency = cleanString(session.currency, 10).toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(userId) || credits !== REPORT_PACK.credits ||
      currency !== REPORT_PACK.currency || subtotal !== REPORT_PACK.priceCents ||
      !Number.isSafeInteger(total) || total < subtotal || total > 10000) {
    throw new Error("Stripe Revenue Leak Finder purchase metadata is invalid.");
  }
  await rpc("revenue_leak_fulfill_purchase", {
    p_event_id: cleanString(event.id, 255),
    p_checkout_id: cleanString(session.id, 255),
    p_payment_intent_id: cleanString(session.payment_intent, 255) || null,
    p_user_id: userId,
    p_currency: currency,
    p_amount_subtotal: subtotal,
    p_amount_total: total,
    p_credits: credits,
    p_livemode: event.livemode === true,
  }, env);
  return true;
}
