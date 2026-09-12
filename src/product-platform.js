"use strict";

const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const REFRESH_COOKIE_SECONDS = 30 * 24 * 60 * 60;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function cleanString(value, maximumLength = 500) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\u0000-\u001f]/g, "").trim().slice(0, maximumLength)
    : "";
}

export function jsonResponse(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export async function fetchWithTimeout(resource, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function readJson(request, maximumBytes = 32768) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
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
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request contains invalid JSON.");
    error.status = 400;
    throw error;
  }
}

function requireConfiguration(env, names) {
  const missing = names.filter((name) => !cleanString(env[name], 8192));
  if (missing.length) throw new Error(`Missing bindings: ${missing.join(", ")}`);
}

function supabaseBaseUrl(env) {
  return cleanString(env.SUPABASE_URL, 500).replace(/\/+$/, "");
}

export async function serviceRequest(path, options = {}, env, prefer) {
  requireConfiguration(env, ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  const secret = cleanString(env.SUPABASE_SECRET_KEY, 8192);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: secret,
    ...(secret.startsWith("sb_") ? {} : { Authorization: `Bearer ${secret}` }),
    ...(prefer ? { Prefer: prefer } : {}),
    ...(options.headers || {}),
  };
  const response = await fetchWithTimeout(`${supabaseBaseUrl(env)}/rest/v1/${path}`, { ...options, headers }, 15000);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const error = new Error(`Storage request failed (${response.status}): ${String(text).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function rpc(name, payload, env) {
  return serviceRequest(`rpc/${name}`, { method: "POST", body: JSON.stringify(payload) }, env);
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function sessionCookie(name, value, maxAge, request, path) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "HttpOnly",
    "SameSite=Strict",
    new URL(request.url).protocol === "https:" ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

async function authRequest(path, payload, env, options = {}) {
  requireConfiguration(env, ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
  const key = cleanString(env.SUPABASE_PUBLISHABLE_KEY, 8192);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: key,
    "X-Client-Info": "intelligent-decisions-product-suite/1.0",
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    ...(options.remoteIp ? { "X-Forwarded-For": options.remoteIp } : {}),
  };
  const response = await fetchWithTimeout(`${supabaseBaseUrl(env)}/auth/v1/${path}`, {
    method: payload === null ? "GET" : "POST",
    headers,
    body: payload === null ? undefined : JSON.stringify(payload),
  });
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

function normalizeSession(body) {
  const accessToken = cleanString(body?.access_token, 8192);
  const refreshToken = cleanString(body?.refresh_token, 8192);
  const expiresIn = Number(body?.expires_in);
  const id = cleanString(body?.user?.id, 80);
  const email = cleanString(body?.user?.email, 320).toLowerCase();
  if (!accessToken || !refreshToken || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || !id || !email) {
    throw new Error("Authentication returned an incomplete session.");
  }
  return { accessToken, refreshToken, expiresIn, user: { id, email } };
}

export function createProductAuth({ accessCookie, refreshCookie, cookiePath, product, turnstileAction }) {
  function appendSessionCookies(headers, session, request) {
    headers.append("Set-Cookie", sessionCookie(accessCookie, session.accessToken, session.expiresIn, request, cookiePath));
    headers.append("Set-Cookie", sessionCookie(refreshCookie, session.refreshToken, REFRESH_COOKIE_SECONDS, request, cookiePath));
  }
  function expireCookies(headers, request) {
    headers.append("Set-Cookie", sessionCookie(accessCookie, "", 0, request, cookiePath));
    headers.append("Set-Cookie", sessionCookie(refreshCookie, "", 0, request, cookiePath));
  }
  return {
    async identity(request, env) {
      const token = cookieValue(request, accessCookie);
      if (!token) return null;
      try {
        const body = await authRequest("user", null, env, { accessToken: token });
        const id = cleanString(body?.id, 80);
        const email = cleanString(body?.email, 320).toLowerCase();
        return id && email ? { id, email } : null;
      } catch { return null; }
    },
    async requestCode(email, token, request, env) {
      if (!await verifyTurnstile(token, request, env, turnstileAction)) return false;
      await authRequest("otp", { email, create_user: true, data: { product } }, env, {
        remoteIp: cleanString(request.headers.get("CF-Connecting-IP"), 80),
      });
      return true;
    },
    async verifyCode(email, code, env) {
      return normalizeSession(await authRequest("verify", { type: "email", email, token: code }, env));
    },
    async refresh(request, env) {
      const token = cookieValue(request, refreshCookie);
      if (!token) return null;
      return normalizeSession(await authRequest("token?grant_type=refresh_token", { refresh_token: token }, env));
    },
    async revoke(request, env) {
      const token = cookieValue(request, accessCookie);
      if (token) await authRequest("logout?scope=local", {}, env, { accessToken: token });
    },
    appendSessionCookies,
    expireCookies,
  };
}

export async function verifyTurnstile(token, request, env, action) {
  requireConfiguration(env, ["TURNSTILE_SECRET_KEY"]);
  if (!cleanString(token, 2048)) return false;
  const response = await fetchWithTimeout(TURNSTILE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: cleanString(request.headers.get("CF-Connecting-IP"), 80),
      idempotency_key: crypto.randomUUID(),
    }),
  }, 8000);
  if (!response.ok) return false;
  const result = await response.json();
  return result?.success === true && result?.action === action &&
    ["intelligentdecisions.io", "www.intelligentdecisions.io"].includes(result?.hostname);
}

function parseStripeSignature(header) {
  const parsed = { timestamp: 0, signatures: [] };
  for (const part of String(header || "").split(",")) {
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
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

export async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!Number.isInteger(timestamp) || !signatures.length || !cleanString(secret, 8192)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const payload = encoder.encode(`${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    if (bytes && await crypto.subtle.verify("HMAC", key, bytes, payload)) return true;
  }
  return false;
}

export function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
