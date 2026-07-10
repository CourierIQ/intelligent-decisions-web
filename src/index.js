"use strict";

const ALLOWED_HOSTNAMES = new Set([
  "intelligentdecisions.io",
  "www.intelligentdecisions.io",
]);

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

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TURNSTILE_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const BETA_FROM_EMAIL = "CourierIQ Beta <beta@intelligentdecisions.io>";
const BETA_NOTIFICATION_TO = "bhall@intelligentdecisions.io";

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
  if (typeof value !== "string") {
    return "";
  }

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

  if (!origin) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "https:" && ALLOWED_HOSTNAMES.has(originUrl.hostname);
  } catch {
    return false;
  }
}

function validateSubmission(payload) {
  const firstName = cleanString(payload.first_name, 80);
  const email = cleanString(payload.email, 254).toLowerCase();
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

  if (website) {
    return { honeypot: true };
  }

  if (firstName.length < 1) {
    return { error: "Enter your first name." };
  }

  if (!isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  if (state && state.length < 2) {
    return { error: "Enter a valid state." };
  }

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
    return await fetch(resource, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTurnstile(token, request, env) {
  const remoteIp = request.headers.get("CF-Connecting-IP") || undefined;

  let response;

  try {
    response = await fetchWithTimeout(
      TURNSTILE_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
  const hostnameAllowed = ALLOWED_HOSTNAMES.has(result.hostname);

  return {
    success:
      result.success === true &&
      result.action === "beta_access" &&
      hostnameAllowed,
  };
}

function supabaseHeaders(env, prefer) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SECRET_KEY,
  };

  // Legacy service_role keys are JWTs and need Authorization. New sb_secret_
  // keys must be passed through the apikey header instead.
  if (!env.SUPABASE_SECRET_KEY.startsWith("sb_")) {
    headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
  }

  if (prefer) {
    headers.Prefer = prefer;
  }

  return headers;
}

function supabaseBaseUrl(env) {
  return env.SUPABASE_URL.replace(/\/+$/, "");
}

async function upsertApplication(application, env) {
  const endpoint =
    `${supabaseBaseUrl(env)}/rest/v1/beta_access_requests` +
    "?on_conflict=email_normalized" +
    "&select=id,status,admin_email_status,applicant_email_status,created_at";

  const response = await fetchWithTimeout(
    endpoint,
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
          state: application.state,
          android_device: application.androidDevice,
          delivery_platforms: application.deliveryPlatforms,
          weekly_deliveries: application.weeklyDeliveries,
          interest_reason: application.interestReason,
          consent_at: new Date().toISOString(),
          source: "idi_website",
          updated_at: new Date().toISOString(),
        },
      ]),
    },
    10000,
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase upsert failed (${response.status}): ${responseText.slice(0, 500)}`,
    );
  }

  const rows = responseText ? JSON.parse(responseText) : [];
  const storedApplication = rows[0];

  if (!storedApplication?.id) {
    throw new Error("Supabase did not return the stored application.");
  }

  return storedApplication;
}

async function updateApplicationEmailStatus(applicationId, changes, env) {
  const endpoint =
    `${supabaseBaseUrl(env)}/rest/v1/beta_access_requests` +
    `?id=eq.${encodeURIComponent(applicationId)}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "PATCH",
      headers: supabaseHeaders(env, "return=minimal"),
      body: JSON.stringify({
        ...changes,
        updated_at: new Date().toISOString(),
      }),
    },
    10000,
  );

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Supabase status update failed (${response.status}): ${responseText.slice(0, 500)}`,
    );
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatSubmissionTime() {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date());
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
      <div style="font-family:Arial,Helvetica,sans-serif;color:#17202a;line-height:1.6;max-width:680px;margin:0 auto;">
        <h1 style="font-size:24px;margin:0 0 20px;">New CourierIQ beta request</h1>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:700;width:190px;">Applicant</td><td style="padding:8px 0;">${escapeHtml(application.firstName)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Email</td><td style="padding:8px 0;"><a href="mailto:${escapeHtml(application.email)}">${escapeHtml(application.email)}</a></td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">State</td><td style="padding:8px 0;">${escapeHtml(state)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Android device</td><td style="padding:8px 0;">${escapeHtml(application.androidDevice)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Platforms</td><td style="padding:8px 0;">${escapeHtml(platforms)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Deliveries per week</td><td style="padding:8px 0;">${escapeHtml(application.weeklyDeliveries)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;vertical-align:top;">Interest</td><td style="padding:8px 0;">${escapeHtml(reason).replaceAll("\n", "<br>")}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Submitted</td><td style="padding:8px 0;">${escapeHtml(submittedAt)} ET</td></tr>
        </table>
      </div>
    `,
    text: [
      "New CourierIQ beta request",
      "",
      `Applicant: ${application.firstName}`,
      `Email: ${application.email}`,
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
      <div style="font-family:Arial,Helvetica,sans-serif;color:#17202a;line-height:1.7;max-width:620px;margin:0 auto;">
        <h1 style="font-size:24px;margin:0 0 18px;">We received your request.</h1>
        <p>Hi ${escapeHtml(application.firstName)},</p>
        <p>Thanks for requesting access to the CourierIQ private beta.</p>
        <p>We have received your information and will review it as beta capacity becomes available. Submitting a request does not guarantee immediate access.</p>
        <p style="margin-top:28px;">— Intelligent Decisions Interactive<br><strong>Clarity over Complexity.</strong></p>
      </div>
    `,
    text: [
      `Hi ${application.firstName},`,
      "",
      "Thanks for requesting access to the CourierIQ private beta.",
      "",
      "We have received your information and will review it as beta capacity becomes available. Submitting a request does not guarantee immediate access.",
      "",
      "— Intelligent Decisions Interactive",
      "Clarity over Complexity.",
    ].join("\n"),
  };
}

async function processAdminNotification(application, storedApplication, env) {
  if (storedApplication.admin_email_status === "sent") {
    return;
  }

  try {
    const resendId = await sendResendEmail(
      buildAdminEmail(application),
      `beta-admin/${storedApplication.id}`,
      env,
    );

    await updateApplicationEmailStatus(
      storedApplication.id,
      {
        admin_email_status: "sent",
        admin_resend_id: resendId,
      },
      env,
    );
  } catch (error) {
    console.error("Admin beta email failed", error);

    try {
      await updateApplicationEmailStatus(
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
  if (storedApplication.applicant_email_status === "sent") {
    return;
  }

  try {
    const resendId = await sendResendEmail(
      buildApplicantEmail(application),
      `beta-applicant/${storedApplication.id}`,
      env,
    );

    await updateApplicationEmailStatus(
      storedApplication.id,
      {
        applicant_email_status: "sent",
        applicant_resend_id: resendId,
      },
      env,
    );
  } catch (error) {
    console.error("Applicant beta email failed", error);

    try {
      await updateApplicationEmailStatus(
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

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      { success: false, message: "Request must use JSON." },
      415,
    );
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);

  if (declaredLength > 20000) {
    return jsonResponse(
      { success: false, message: "Request is too large." },
      413,
    );
  }

  let rawBody;

  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse(
      { success: false, message: "Request could not be read." },
      400,
    );
  }

  if (rawBody.length > 20000) {
    return jsonResponse(
      { success: false, message: "Request is too large." },
      413,
    );
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(
      { success: false, message: "Request contains invalid JSON." },
      400,
    );
  }

  const validation = validateSubmission(payload);

  // Quietly accept honeypot submissions without storing or sending anything.
  if (validation.honeypot) {
    return jsonResponse({
      success: true,
      message: "Your CourierIQ beta request has been received.",
    });
  }

  if (validation.error) {
    return jsonResponse(
      { success: false, message: validation.error },
      400,
    );
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
        service: "intelligent-decisions-web",
        worker: "active",
        supabaseUrlConfigured: Boolean(env.SUPABASE_URL),
        supabaseSecretConfigured: Boolean(env.SUPABASE_SECRET_KEY),
        resendConfigured: Boolean(env.RESEND_API_KEY),
        turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY),
      });
    }

    if (url.pathname === "/api/beta-access") {
      return handleBetaAccess(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse(
        { success: false, message: "API route not found." },
        404,
      );
    }

    return env.ASSETS.fetch(request);
  },
};
