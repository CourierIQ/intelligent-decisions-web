"use strict";

const ALLOWED_HOSTNAMES = new Set([
  "intelligentdecisions.io",
  "www.intelligentdecisions.io",
]);
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
const BETA_FROM_EMAIL =
  "CourierIQ Beta <beta@intelligentdecisions.io>";
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
  };

  // Legacy service_role JWTs require Authorization. New sb_secret_ keys
  // are passed through the apikey header only.
  if (!env.SUPABASE_SECRET_KEY.startsWith("sb_")) {
    headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
  }
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
        betaInviteConfigured: Boolean(env.BETA_INVITE_URL),
      });
    }

    if (url.pathname === "/api/beta-access") {
      return handleBetaAccess(request, env);
    }

    if (url.pathname.startsWith("/admin/api/")) {
      return handleAdminApi(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ success: false, message: "API route not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
