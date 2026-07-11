"use strict";

const state = {
  applications: [],
  selectedId: null,
  selected: null,
  events: [],
  inviteEnabled: false,
  actorEmail: "",
  loading: false,
};

const elements = {
  adminIdentity: document.querySelector("#adminIdentity"),
  refreshButton: document.querySelector("#refreshButton"),
  summaryStats: document.querySelector("#summaryStats"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  listState: document.querySelector("#listState"),
  applicantList: document.querySelector("#applicantList"),
  emptyDetail: document.querySelector("#emptyDetail"),
  detailContent: document.querySelector("#detailContent"),
  detailName: document.querySelector("#detailName"),
  detailEmail: document.querySelector("#detailEmail"),
  detailStatus: document.querySelector("#detailStatus"),
  detailMessage: document.querySelector("#detailMessage"),
  profileDetails: document.querySelector("#profileDetails"),
  emailDetails: document.querySelector("#emailDetails"),
  interestReason: document.querySelector("#interestReason"),
  retryAdminEmail: document.querySelector("#retryAdminEmail"),
  retryApplicantEmail: document.querySelector("#retryApplicantEmail"),
  reviewForm: document.querySelector("#reviewForm"),
  reviewStatus: document.querySelector("#reviewStatus"),
  adminNotes: document.querySelector("#adminNotes"),
  notesCount: document.querySelector("#notesCount"),
  saveReviewButton: document.querySelector("#saveReviewButton"),
  sendInviteButton: document.querySelector("#sendInviteButton"),
  inviteHelp: document.querySelector("#inviteHelp"),
  historyCount: document.querySelector("#historyCount"),
  historyList: document.querySelector("#historyList"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value, includeTime = true) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

function setDetailMessage(message = "", type = "") {
  elements.detailMessage.textContent = message;
  elements.detailMessage.dataset.state = type;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok || body.success === false) {
    throw new Error(body.message || `Request failed (${response.status}).`);
  }
  return body;
}

function statusPill(status) {
  const safe = escapeHtml(status || "pending");
  return `<span class="status-pill" data-status="${safe}">${safe}</span>`;
}

function renderSummary() {
  const counts = state.applications.reduce(
    (result, application) => {
      result.total += 1;
      if (application.status === "pending") result.pending += 1;
      if (["approved", "invited", "active"].includes(application.status)) {
        result.accepted += 1;
      }
      return result;
    },
    { total: 0, pending: 0, accepted: 0 },
  );

  elements.summaryStats.innerHTML = [
    [counts.total, "Total requests"],
    [counts.pending, "Awaiting review"],
    [counts.accepted, "Approved forward"],
  ]
    .map(
      ([value, label]) => `
        <article class="stat-card">
          <strong>${value}</strong>
          <span>${label}</span>
        </article>
      `,
    )
    .join("");
}

function filteredApplications() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const status = elements.statusFilter.value;

  return state.applications.filter((application) => {
    const matchesStatus = status === "all" || application.status === status;
    const haystack = [
      application.first_name,
      application.email,
      application.android_device,
      application.state,
      ...(application.delivery_platforms || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });
}

function renderApplicantList() {
  const applications = filteredApplications();
  elements.listState.hidden = applications.length > 0;
  elements.listState.textContent = state.applications.length
    ? "No applicants match the current filters."
    : "No beta requests have been submitted yet.";

  elements.applicantList.innerHTML = applications
    .map((application) => {
      const selected = application.id === state.selectedId;
      return `
        <button
          class="applicant-item"
          type="button"
          role="listitem"
          data-application-id="${escapeHtml(application.id)}"
          aria-current="${selected ? "true" : "false"}"
        >
          <span class="applicant-item-heading">
            <strong>${escapeHtml(application.first_name)}</strong>
            ${statusPill(application.status)}
          </span>
          <span class="applicant-item-email">${escapeHtml(application.email)}</span>
          <span class="applicant-item-meta">
            <span>${escapeHtml(application.weekly_deliveries || "Unknown volume")}/week</span>
            <span>${escapeHtml(formatDate(application.created_at, false))}</span>
          </span>
        </button>
      `;
    })
    .join("");
}

function detailRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function emailState(status) {
  const value = status || "unknown";
  return `<span class="email-state" data-state="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function renderHistory() {
  elements.historyCount.textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"}`;

  if (!state.events.length) {
    elements.historyList.innerHTML = `
      <div class="history-item">
        <span class="history-dot"></span>
        <div>
          <strong>Request submitted</strong>
          <p>${escapeHtml(formatDate(state.selected?.created_at))}</p>
        </div>
      </div>
    `;
    return;
  }

  elements.historyList.innerHTML = state.events
    .map((event) => {
      const label = event.event_type.replaceAll("_", " ");
      const transition =
        event.previous_status && event.new_status && event.previous_status !== event.new_status
          ? ` · ${event.previous_status} → ${event.new_status}`
          : "";
      return `
        <div class="history-item">
          <span class="history-dot"></span>
          <div>
            <strong>${escapeHtml(label)}</strong>
            <p>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_email)}${escapeHtml(transition)}</p>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderDetail() {
  const application = state.selected;
  if (!application) {
    elements.emptyDetail.hidden = false;
    elements.detailContent.hidden = true;
    return;
  }

  elements.emptyDetail.hidden = true;
  elements.detailContent.hidden = false;
  elements.detailName.textContent = application.first_name;
  elements.detailEmail.textContent = application.email;
  elements.detailEmail.href = `mailto:${encodeURIComponent(application.email)}`;
  elements.detailStatus.textContent = application.status;
  elements.detailStatus.dataset.status = application.status;

  elements.profileDetails.innerHTML = [
    detailRow("State", escapeHtml(application.state || "Not provided")),
    detailRow("Android device", escapeHtml(application.android_device || "Not provided")),
    detailRow("Platforms", escapeHtml((application.delivery_platforms || []).join(", ") || "Not provided")),
    detailRow("Deliveries", escapeHtml(`${application.weekly_deliveries || "Unknown"} per week`)),
    detailRow("Submitted", escapeHtml(formatDate(application.created_at))),
    detailRow("Last updated", escapeHtml(formatDate(application.updated_at))),
  ].join("");

  elements.emailDetails.innerHTML = [
    detailRow("Admin notice", emailState(application.admin_email_status)),
    detailRow("Applicant confirmation", emailState(application.applicant_email_status)),
    detailRow("Invitation", emailState(application.invite_email_status)),
    detailRow("Invited", escapeHtml(formatDate(application.invited_at))),
    detailRow("Last email error", escapeHtml(application.last_email_error || application.invite_email_error || "None")),
  ].join("");

  elements.interestReason.textContent = application.interest_reason || "No reason was provided.";
  elements.reviewStatus.value = application.status;
  elements.adminNotes.value = application.admin_notes || "";
  elements.notesCount.textContent = String(elements.adminNotes.value.length);

  elements.retryAdminEmail.disabled = application.admin_email_status !== "failed";
  elements.retryApplicantEmail.disabled = application.applicant_email_status !== "failed";
  elements.sendInviteButton.disabled =
    !state.inviteEnabled || !["approved", "invited"].includes(application.status);
  elements.inviteHelp.textContent = !state.inviteEnabled
    ? "Add BETA_INVITE_URL in Cloudflare when distribution is ready."
    : application.status === "approved" || application.status === "invited"
      ? "Ready to send the configured invitation."
      : "Approve the applicant before sending an invitation.";

  renderHistory();
}

function mergeApplication(updated) {
  const index = state.applications.findIndex((item) => item.id === updated.id);
  if (index >= 0) state.applications[index] = updated;
  state.selected = updated;
  state.selectedId = updated.id;
  renderSummary();
  renderApplicantList();
  renderDetail();
}

async function loadApplications({ preserveSelection = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.listState.hidden = false;
  elements.listState.textContent = "Loading applicants…";

  try {
    const result = await apiRequest("/admin/api/requests");
    state.applications = result.applications || [];
    state.actorEmail = result.actorEmail || "";
    state.inviteEnabled = result.inviteEnabled === true;
    elements.adminIdentity.textContent = state.actorEmail || "Secure session";

    if (!preserveSelection || !state.applications.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
      state.selected = null;
      state.events = [];
    }

    renderSummary();
    renderApplicantList();
    renderDetail();

    if (state.selectedId) await selectApplication(state.selectedId);
  } catch (error) {
    elements.listState.hidden = false;
    elements.listState.textContent = error.message;
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
  }
}

async function selectApplication(applicationId) {
  state.selectedId = applicationId;
  renderApplicantList();
  setDetailMessage("Loading applicant…");

  try {
    const result = await apiRequest(`/admin/api/requests/${encodeURIComponent(applicationId)}`);
    state.selected = result.application;
    state.events = result.events || [];
    state.inviteEnabled = result.inviteEnabled === true;
    mergeApplication(state.selected);
    setDetailMessage();
  } catch (error) {
    setDetailMessage(error.message, "error");
  }
}

async function saveReview(event) {
  event.preventDefault();
  if (!state.selectedId) return;

  elements.saveReviewButton.disabled = true;
  setDetailMessage("Saving review…");

  try {
    const result = await apiRequest(
      `/admin/api/requests/${encodeURIComponent(state.selectedId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: elements.reviewStatus.value,
          admin_notes: elements.adminNotes.value,
        }),
      },
    );
    state.events = result.events || [];
    mergeApplication(result.application);
    setDetailMessage("Review saved.", "success");
  } catch (error) {
    setDetailMessage(error.message, "error");
  } finally {
    elements.saveReviewButton.disabled = false;
  }
}

async function retryEmail(type) {
  if (!state.selectedId) return;
  const button = type === "admin" ? elements.retryAdminEmail : elements.retryApplicantEmail;
  button.disabled = true;
  setDetailMessage("Sending email…");

  try {
    const result = await apiRequest(
      `/admin/api/requests/${encodeURIComponent(state.selectedId)}/retry-email`,
      {
        method: "POST",
        body: JSON.stringify({ type }),
      },
    );
    state.events = result.events || [];
    mergeApplication(result.application);
    setDetailMessage("Email sent.", "success");
  } catch (error) {
    setDetailMessage(error.message, "error");
    button.disabled = false;
  }
}

async function sendInvite() {
  if (!state.selectedId || !state.inviteEnabled) return;
  elements.sendInviteButton.disabled = true;
  setDetailMessage("Sending beta invitation…");

  try {
    const result = await apiRequest(
      `/admin/api/requests/${encodeURIComponent(state.selectedId)}/invite`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    state.events = result.events || [];
    mergeApplication(result.application);
    setDetailMessage("Invitation sent.", "success");
  } catch (error) {
    setDetailMessage(error.message, "error");
    elements.sendInviteButton.disabled = false;
  }
}

elements.refreshButton.addEventListener("click", () => loadApplications());
elements.searchInput.addEventListener("input", renderApplicantList);
elements.statusFilter.addEventListener("change", renderApplicantList);
elements.applicantList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-application-id]");
  if (button) selectApplication(button.dataset.applicationId);
});
elements.reviewForm.addEventListener("submit", saveReview);
elements.adminNotes.addEventListener("input", () => {
  elements.notesCount.textContent = String(elements.adminNotes.value.length);
});
elements.retryAdminEmail.addEventListener("click", () => retryEmail("admin"));
elements.retryApplicantEmail.addEventListener("click", () => retryEmail("applicant"));
elements.sendInviteButton.addEventListener("click", sendInvite);

loadApplications({ preserveSelection: false });
