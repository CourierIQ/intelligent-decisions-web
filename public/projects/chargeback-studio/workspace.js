"use strict";

const SUPABASE_URL = "https://jlbtbpngvqyaiatslphi.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dXtSleDC4yB8OOrOMLmPJg_7n9-i8Lu";
const EVIDENCE_BUCKET = "chargeback-evidence";
const APP_URL = new URL("./", window.location.href).href;
const COMPLETE_STATUSES = new Set(["won", "partially_won", "lost", "closed"]);
const STATUS_LABELS = {
  draft: "Draft",
  evidence_needed: "Evidence needed",
  ready: "Ready",
  submitted: "Submitted",
  under_review: "Under review",
  won: "Won",
  partially_won: "Partially won",
  lost: "Lost",
  closed: "Closed",
};

const studio = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const workspaceState = {
  session: null,
  organization: null,
  membership: null,
  disputes: [],
  evidence: [],
  packs: [],
  packLinks: [],
  filter: "all",
  activePackId: null,
  bootingUserId: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

function formatMoney(cents = 0, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(cents || 0) / 100);
  } catch {
    return `$${Math.round(Number(cents || 0) / 100).toLocaleString()}`;
  }
}

function formatDate(value, short = false) {
  if (!value) return "No deadline";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", short
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function initials(value = "") {
  const letters = value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("");
  return (letters || "CS").toUpperCase();
}

function showAuth() {
  workspaceState.session = null;
  workspaceState.bootingUserId = null;
  $("#launch-screen").hidden = true;
  $("#workspace-shell").hidden = true;
  $("#auth-shell").hidden = false;
}

function showWorkspace() {
  $("#launch-screen").hidden = true;
  $("#auth-shell").hidden = true;
  $("#workspace-shell").hidden = false;
}

function setAuthMode(mode) {
  const signup = mode === "signup";
  $$("[data-auth-mode]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.authMode === mode)));
  $$(".signup-only").forEach((field) => { field.hidden = !signup; });
  $("#auth-kicker").textContent = signup ? "Start free" : "Welcome back";
  $("#auth-title").textContent = signup ? "Create your workspace" : "Open your workspace";
  $("#auth-intro").textContent = signup
    ? "Tracking and readiness are free. Pay only when you unlock a clean response pack."
    : "Your disputes, packs, deadlines, and recovery totals are waiting.";
  $("#auth-form [name=password]").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-form .account-submit span").textContent = signup ? "Create account" : "Sign in";
  $("#auth-form").dataset.mode = mode;
  $("#auth-message").textContent = "";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!studio) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");
  const mode = form.dataset.mode || "signin";
  const button = $(".account-submit", form);
  const message = $("#auth-message");
  button.disabled = true;
  message.textContent = mode === "signup" ? "Creating your secure workspace…" : "Signing in…";
  message.dataset.kind = "";

  try {
    if (mode === "signup") {
      const displayName = String(data.get("display_name") || "").trim();
      const businessName = String(data.get("business_name") || "").trim();
      if (!displayName || !businessName) throw new Error("Enter your name and business name.");
      const { data: result, error } = await studio.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: APP_URL,
          data: { display_name: displayName, business_name: businessName },
        },
      });
      if (error) throw error;
      if (!result.session) {
        message.dataset.kind = "success";
        message.textContent = "Check your email to confirm the account, then return here to sign in.";
      }
    } else {
      const { error } = await studio.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (error) {
    message.textContent = error?.message || "The account request could not be completed.";
  } finally {
    button.disabled = false;
  }
}

async function loadWorkspace(session) {
  if (!session?.user || workspaceState.bootingUserId === session.user.id) return;
  workspaceState.bootingUserId = session.user.id;
  workspaceState.session = session;

  try {
    const { data: membership, error: membershipError } = await studio
      .from("chargeback_organization_members")
      .select("organization_id,role")
      .eq("user_id", session.user.id)
      .limit(1)
      .single();
    if (membershipError) throw membershipError;

    const { data: organization, error: organizationError } = await studio
      .from("chargeback_organizations")
      .select("id,name")
      .eq("id", membership.organization_id)
      .single();
    if (organizationError) throw organizationError;
    workspaceState.membership = membership;
    workspaceState.organization = organization;
    showWorkspace();
    renderAccount();
    await refreshWorkspace();

    const checkoutState = new URLSearchParams(location.search).get("checkout");
    if (checkoutState) activateView("builder");
    else activateView(location.hash.replace("#", "") || "dashboard");
    if (checkoutState) void window.chargebackBuilder?.verifyCheckout();
  } catch (error) {
    console.error("Chargeback Studio workspace failed to load", error);
    workspaceState.bootingUserId = null;
    await studio.auth.signOut();
    showAuth();
    $("#auth-message").textContent = "Your account exists, but its workspace could not be opened. Please try again.";
  }
}

async function refreshWorkspace() {
  const organizationId = workspaceState.organization.id;
  const [disputesResult, evidenceResult, packsResult, packLinksResult] = await Promise.all([
    studio.from("chargeback_disputes").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    studio.from("chargeback_evidence_files").select("*").eq("organization_id", organizationId).order("created_at", { ascending: true }),
    studio.from("chargeback_packs").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    studio.from("chargeback_pack_disputes").select("*").eq("organization_id", organizationId).order("position", { ascending: true }),
  ]);
  const failure = [disputesResult, evidenceResult, packsResult, packLinksResult].find((result) => result.error);
  if (failure) throw failure.error;
  workspaceState.disputes = disputesResult.data || [];
  workspaceState.evidence = evidenceResult.data || [];
  workspaceState.packs = packsResult.data || [];
  workspaceState.packLinks = packLinksResult.data || [];
  renderAll();
}

function renderAccount() {
  const user = workspaceState.session.user;
  const displayName = user.user_metadata?.display_name || user.email?.split("@")[0] || "Workspace";
  $("#account-name").textContent = displayName;
  $("#account-email").textContent = user.email || "";
  $("#account-avatar").textContent = initials(displayName);
  $("#organization-name").textContent = workspaceState.organization.name;
  $("#workspace-date").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

function activeDisputes() { return workspaceState.disputes.filter((item) => !COMPLETE_STATUSES.has(item.status)); }
function completedDisputes() { return workspaceState.disputes.filter((item) => COMPLETE_STATUSES.has(item.status)); }
function evidenceCount(disputeId) { return workspaceState.evidence.filter((item) => item.dispute_id === disputeId).length; }

function calculateReadiness(dispute, fileCount = evidenceCount(dispute.id)) {
  let score = 10;
  if (dispute.order_reference) score += 10;
  if (dispute.dispute_received_at) score += 10;
  if (dispute.response_due_at) score += 10;
  if ((dispute.summary || "").length >= 80) score += 20;
  score += Math.min(30, fileCount * 10);
  if (["ready", "submitted", "under_review", "won", "partially_won"].includes(dispute.status)) score += 10;
  return Math.min(100, score);
}

function renderMetrics() {
  const active = activeDisputes();
  const completed = completedDisputes();
  const risk = active.reduce((sum, item) => sum + Number(item.amount_cents), 0);
  const disputedCompleted = completed.reduce((sum, item) => sum + Number(item.amount_cents), 0);
  const recovered = completed.reduce((sum, item) => sum + Number(item.recovery_cents), 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sevenDays = new Date(today); sevenDays.setDate(sevenDays.getDate() + 7);
  const due = active.filter((item) => item.response_due_at && new Date(`${item.response_due_at}T12:00:00`) >= today && new Date(`${item.response_due_at}T12:00:00`) <= sevenDays).length;
  const overdue = active.filter((item) => item.response_due_at && new Date(`${item.response_due_at}T12:00:00`) < today).length;
  const wins = completed.filter((item) => item.status === "won" || item.status === "partially_won").length;
  $("#metric-active").textContent = active.length;
  $("#metric-risk").textContent = `${formatMoney(risk)} at risk`;
  $("#metric-due").textContent = due;
  $("#metric-overdue").textContent = `${overdue} overdue`;
  $("#metric-recovered").textContent = formatMoney(recovered);
  $("#metric-recovery-rate").textContent = `${disputedCompleted ? Math.round((recovered / disputedCompleted) * 100) : 0}% recovery rate`;
  $("#metric-completed").textContent = completed.length;
  $("#metric-win-rate").textContent = `${completed.length ? Math.round((wins / completed.length) * 100) : 0}% win rate`;
  $("#nav-active-count").textContent = active.length;
}

function renderChart() {
  const months = [];
  const cursor = new Date(); cursor.setDate(1); cursor.setHours(0, 0, 0, 0);
  for (let index = 5; index >= 0; index -= 1) {
    const start = new Date(cursor.getFullYear(), cursor.getMonth() - index, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const disputed = workspaceState.disputes.filter((item) => {
      const date = new Date(item.created_at); return date >= start && date < end;
    }).reduce((sum, item) => sum + Number(item.amount_cents), 0);
    const recovered = workspaceState.disputes.filter((item) => {
      if (!item.completed_at) return false; const date = new Date(item.completed_at); return date >= start && date < end;
    }).reduce((sum, item) => sum + Number(item.recovery_cents), 0);
    months.push({ label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(start), disputed, recovered });
  }
  const maximum = Math.max(1, ...months.flatMap((month) => [month.disputed, month.recovered]));
  $("#recovery-chart").innerHTML = months.map((month) => `<div class="chart-month"><div class="chart-bars" title="${escapeHTML(month.label)}: ${formatMoney(month.disputed)} disputed, ${formatMoney(month.recovered)} recovered"><i style="height:${Math.max(2, (month.disputed / maximum) * 100)}%"></i><i style="height:${Math.max(2, (month.recovered / maximum) * 100)}%"></i></div><span>${escapeHTML(month.label)}</span></div>`).join("");
}

function deadlineInfo(dispute) {
  if (!dispute.response_due_at) return { label: "No deadline", days: null, overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const deadline = new Date(`${dispute.response_due_at}T12:00:00`);
  const days = Math.ceil((deadline - today) / 86400000);
  return { label: days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Due today" : `${days}d left`, days, overdue: days < 0 };
}

function renderDeadlineQueue() {
  const queue = activeDisputes().filter((item) => item.response_due_at).sort((a, b) => a.response_due_at.localeCompare(b.response_due_at)).slice(0, 5);
  $("#deadline-queue").innerHTML = queue.length ? queue.map((item) => {
    const deadline = deadlineInfo(item);
    return `<div class="deadline-item"><div><strong>${escapeHTML(item.case_reference)}</strong><span>${escapeHTML(item.processor)} · ${formatMoney(item.amount_cents, item.currency)}</span></div><span class="deadline-badge ${deadline.days !== null && deadline.days > 7 ? "is-safe" : ""}">${escapeHTML(deadline.label)}</span></div>`;
  }).join("") : `<div class="mini-empty">No active deadlines yet.</div>`;
}

function statusOptions(current) {
  return Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`).join("");
}

function disputeRow(item, selectable = false) {
  const readiness = calculateReadiness(item);
  return `<tr data-dispute-row="${item.id}">
    ${selectable ? `<td><input type="checkbox" data-select-dispute value="${item.id}" aria-label="Select ${escapeHTML(item.case_reference)}" /></td>` : ""}
    <td><div class="case-cell"><strong>${escapeHTML(item.case_reference)}</strong><span>${escapeHTML(item.order_reference || STATUS_LABELS[item.status])}</span></div></td>
    <td>${escapeHTML(item.processor)}</td><td>${formatMoney(item.amount_cents, item.currency)}</td>
    <td>${escapeHTML(formatDate(item.response_due_at, true))}</td>
    ${selectable ? `<td>${formatMoney(item.recovery_cents, item.currency)}</td>` : `<td><span class="readiness"><i style="--score:${readiness}%"></i><span>${readiness}%</span></span></td>`}
    <td><select class="status-select" data-status-for="${item.id}" aria-label="Status for ${escapeHTML(item.case_reference)}">${statusOptions(item.status)}</select></td>
    ${selectable ? `<td><div class="case-actions"><button class="edit-case" type="button" data-edit-dispute="${item.id}" aria-label="Edit ${escapeHTML(item.case_reference)}">Edit</button><button class="delete-case" type="button" data-delete-dispute="${item.id}" aria-label="Delete ${escapeHTML(item.case_reference)}">Delete</button></div></td>` : ""}
  </tr>`;
}

function renderDisputes() {
  const active = activeDisputes();
  $("#active-disputes-body").innerHTML = active.length ? active.slice(0, 6).map((item) => disputeRow(item)).join("") : `<tr><td colspan="6"><div class="mini-empty">No active disputes. Add a case to begin.</div></td></tr>`;
  const filtered = workspaceState.filter === "active" ? active : workspaceState.filter === "completed" ? completedDisputes() : workspaceState.disputes;
  $("#all-disputes-body").innerHTML = filtered.map((item) => disputeRow(item, true)).join("");
  $("#disputes-empty").hidden = workspaceState.disputes.length > 0;
  $$("[data-status-for]").forEach((select) => select.addEventListener("change", handleStatusChange));
  $$("[data-edit-dispute]").forEach((button) => button.addEventListener("click", () => openDisputeDialog(button.dataset.editDispute)));
  $$("[data-delete-dispute]").forEach((button) => button.addEventListener("click", () => deleteDispute(button.dataset.deleteDispute)));
}

function packTier(caseCount, fileCount) {
  void caseCount;
  if (fileCount <= 20) return { code: "single", price: 29 };
  if (fileCount <= 50) return { code: "multi", price: 49 };
  if (fileCount <= 100) return { code: "volume", price: 79 };
  return { code: "subscription", price: null };
}

function renderPacks() {
  $("#packs-empty").hidden = workspaceState.packs.length > 0;
  $("#pack-grid").innerHTML = workspaceState.packs.map((pack) => {
    const tier = packTier(pack.case_count, pack.file_count);
    return `<article class="pack-card"><header><div><p class="workspace-eyebrow">${escapeHTML(pack.status.replace("_", " "))}</p><h2>${escapeHTML(pack.name)}</h2></div><span>${formatDate(pack.created_at)}</span></header><dl><div><dt>Cases</dt><dd>${pack.case_count}</dd></div><div><dt>Files</dt><dd>${pack.file_count}</dd></div><div><dt>${pack.status === "unlocked" ? "Access" : "Unlock"}</dt><dd>${pack.status === "unlocked" ? "Paid" : tier.price ? `$${tier.price}` : "Plan"}</dd></div></dl><footer class="pack-actions"><button class="pack-open" type="button" data-open-pack="${pack.id}">${pack.status === "unlocked" ? "Open clean pack" : "Open marked preview"}</button><button class="pack-delete" type="button" data-delete-pack="${pack.id}" aria-label="Delete ${escapeHTML(pack.name)}">Delete pack</button></footer></article>`;
  }).join("");
  $$("[data-open-pack]").forEach((button) => button.addEventListener("click", () => openPack(button.dataset.openPack)));
  $$("[data-delete-pack]").forEach((button) => button.addEventListener("click", () => deleteResponsePack(button.dataset.deletePack)));
}

async function deleteResponsePack(packId) {
  const pack = workspaceState.packs.find((item) => item.id === packId);
  if (!pack) return;
  const confirmed = window.confirm(`Delete "${pack.name}"?\n\nThe disputes inside it will stay in your workspace.`);
  if (!confirmed) return;
  const button = $(`[data-delete-pack="${packId}"]`);
  if (button) { button.disabled = true; button.textContent = "Deleting…"; }
  try {
    const { error } = await studio.from("chargeback_packs").delete().eq("id", packId).eq("organization_id", workspaceState.organization.id);
    if (error) throw error;
    if (workspaceState.activePackId === packId) workspaceState.activePackId = null;
    await refreshWorkspace();
  } catch (error) {
    console.error("Response pack delete failed", error);
    window.alert(error?.message || "The response pack could not be deleted.");
    if (button) { button.disabled = false; button.textContent = "Delete pack"; }
  }
}

async function deleteDispute(disputeId) {
  const dispute = workspaceState.disputes.find((item) => item.id === disputeId);
  if (!dispute) return;
  const linkedPackIds = [...new Set(workspaceState.packLinks.filter((item) => item.dispute_id === disputeId).map((item) => item.pack_id))];
  const packNote = linkedPackIds.length
    ? `\n\n${linkedPackIds.length} response pack${linkedPackIds.length === 1 ? "" : "s"} containing this dispute will also be deleted. Other disputes will stay.`
    : "";
  const confirmed = window.confirm(`Delete dispute "${dispute.case_reference}"?${packNote}\n\nThis cannot be undone.`);
  if (!confirmed) return;
  const button = $(`[data-delete-dispute="${disputeId}"]`);
  if (button) { button.disabled = true; button.textContent = "Deleting…"; }
  const storagePaths = workspaceState.evidence.filter((item) => item.dispute_id === disputeId).map((item) => item.storage_path);
  try {
    const { error } = await studio.from("chargeback_disputes").delete().eq("id", disputeId).eq("organization_id", workspaceState.organization.id);
    if (error) throw error;

    let cleanupWarning = "";
    if (linkedPackIds.length) {
      const { error: packError } = await studio.from("chargeback_packs").delete().in("id", linkedPackIds).eq("organization_id", workspaceState.organization.id);
      if (packError) {
        console.error("Linked response pack cleanup failed", packError);
        cleanupWarning = "One or more linked response packs could not be removed.";
      }
    }
    if (storagePaths.length) {
      const { error: storageError } = await studio.storage.from(EVIDENCE_BUCKET).remove(storagePaths);
      if (storageError) {
        console.error("Evidence storage cleanup failed", storageError);
        cleanupWarning = `${cleanupWarning} Evidence storage cleanup needs attention.`.trim();
      }
    }
    if (linkedPackIds.includes(workspaceState.activePackId)) workspaceState.activePackId = null;
    await refreshWorkspace();
    if (cleanupWarning) window.alert(`The dispute was deleted. ${cleanupWarning}`);
  } catch (error) {
    console.error("Dispute delete failed", error);
    window.alert(error?.message || "The dispute could not be deleted.");
    if (button) { button.disabled = false; button.textContent = "Delete"; }
  }
}

function renderAll() {
  renderMetrics(); renderChart(); renderDeadlineQueue(); renderDisputes(); renderPacks();
}

function activateView(view) {
  const valid = ["dashboard", "disputes", "packs", "builder"].includes(view) ? view : "dashboard";
  $$("[data-workspace-view]").forEach((section) => section.classList.toggle("is-active", section.dataset.workspaceView === valid));
  $$(".workspace-nav [data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === valid));
  $("#workspace-shell").classList.remove("menu-open");
  if (location.hash !== `#${valid}`) history.replaceState(null, "", `${location.pathname}${location.search}#${valid}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openDisputeDialog(disputeId = "") {
  const form = $("#dispute-form"); form.reset(); form.elements.id.value = disputeId;
  const dispute = workspaceState.disputes.find((item) => item.id === disputeId);
  $("#dispute-dialog-title").textContent = dispute ? `Edit ${dispute.case_reference}` : "New dispute";
  $("#dispute-message").textContent = "";
  if (dispute) {
    for (const key of ["case_reference", "order_reference", "processor", "reason_code", "currency", "dispute_received_at", "response_due_at", "status", "summary"]) {
      if (form.elements[key]) form.elements[key].value = dispute[key] || "";
    }
    form.elements.amount.value = (Number(dispute.amount_cents) / 100).toFixed(2);
    form.elements.recovery.value = (Number(dispute.recovery_cents) / 100).toFixed(2);
  }
  $("#dispute-dialog").showModal();
}

async function saveDispute(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const message = $("#dispute-message"); const submit = $("[type=submit]", form);
  const data = new FormData(form); const id = String(data.get("id") || "");
  submit.disabled = true; message.textContent = "Saving dispute…"; message.dataset.kind = "";
  const now = new Date().toISOString();
  const status = String(data.get("status"));
  const payload = {
    merchant_name: workspaceState.organization.name,
    case_reference: String(data.get("case_reference") || "").trim(),
    order_reference: String(data.get("order_reference") || "").trim() || null,
    processor: String(data.get("processor") || "").trim(),
    reason_code: String(data.get("reason_code")),
    amount_cents: Math.round(Number(data.get("amount") || 0) * 100),
    currency: String(data.get("currency") || "USD"),
    dispute_received_at: String(data.get("dispute_received_at") || "") || null,
    response_due_at: String(data.get("response_due_at") || "") || null,
    status,
    recovery_cents: Math.round(Number(data.get("recovery") || 0) * 100),
    summary: String(data.get("summary") || "").trim(),
    submitted_at: ["submitted", "under_review", "won", "partially_won", "lost", "closed"].includes(status) ? now : null,
    completed_at: COMPLETE_STATUSES.has(status) ? now : null,
  };
  if (status === "won" && payload.recovery_cents === 0) payload.recovery_cents = payload.amount_cents;
  if (status === "lost") payload.recovery_cents = 0;

  try {
    let disputeId = id;
    if (id) {
      const { error } = await studio.from("chargeback_disputes").update(payload).eq("id", id);
      if (error) throw error;
    } else {
      const { data: created, error } = await studio.from("chargeback_disputes").insert({ ...payload, organization_id: workspaceState.organization.id, created_by: workspaceState.session.user.id }).select("id").single();
      if (error) throw error; disputeId = created.id;
    }
    const files = [...form.elements.evidence.files];
    for (const file of files) await uploadEvidence(disputeId, file);
    message.dataset.kind = "success"; message.textContent = "Saved.";
    await refreshWorkspace();
    setTimeout(() => $("#dispute-dialog").close(), 250);
  } catch (error) {
    console.error("Dispute save failed", error);
    message.textContent = error?.message || "The dispute could not be saved.";
  } finally { submit.disabled = false; }
}

async function uploadEvidence(disputeId, file) {
  if (file.size > 26214400) throw new Error(`${file.name} is larger than 25 MB.`);
  const safeName = file.name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-180) || "evidence";
  const path = `${workspaceState.organization.id}/${disputeId}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await studio.storage.from(EVIDENCE_BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploadError) throw uploadError;
  const { error: metadataError } = await studio.from("chargeback_evidence_files").insert({
    organization_id: workspaceState.organization.id, dispute_id: disputeId, created_by: workspaceState.session.user.id,
    storage_path: path, original_name: file.name, mime_type: file.type || "application/octet-stream", size_bytes: file.size, category: "other",
  });
  if (metadataError) { await studio.storage.from(EVIDENCE_BUCKET).remove([path]); throw metadataError; }
}

async function handleStatusChange(event) {
  const id = event.currentTarget.dataset.statusFor; const status = event.currentTarget.value;
  const dispute = workspaceState.disputes.find((item) => item.id === id); if (!dispute) return;
  const payload = { status };
  if (["submitted", "under_review"].includes(status) && !dispute.submitted_at) payload.submitted_at = new Date().toISOString();
  if (COMPLETE_STATUSES.has(status)) payload.completed_at = dispute.completed_at || new Date().toISOString(); else payload.completed_at = null;
  if (status === "won" && Number(dispute.recovery_cents) === 0) payload.recovery_cents = dispute.amount_cents;
  if (status === "lost") payload.recovery_cents = 0;
  const { error } = await studio.from("chargeback_disputes").update(payload).eq("id", id);
  if (error) { console.error(error); event.currentTarget.value = dispute.status; return; }
  await refreshWorkspace();
}

function selectedDisputeIds() { return $$('[data-select-dispute]:checked').map((input) => input.value); }

async function createPackFromSelection() {
  const ids = selectedDisputeIds();
  if (!ids.length) { $("#create-pack-from-list").textContent = "Select at least one dispute"; setTimeout(() => { $("#create-pack-from-list").textContent = "Create response pack"; }, 1800); return; }
  const disputes = ids.map((id) => workspaceState.disputes.find((item) => item.id === id)).filter(Boolean);
  const fileCount = workspaceState.evidence.filter((item) => ids.includes(item.dispute_id)).length;
  const tier = packTier(disputes.length, fileCount);
  const readiness = disputes.length ? Math.round(disputes.reduce((sum, item) => sum + calculateReadiness(item), 0) / disputes.length) : 0;
  const name = `Response pack · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date())}`;
  const { data: pack, error } = await studio.from("chargeback_packs").insert({ organization_id: workspaceState.organization.id, created_by: workspaceState.session.user.id, name, status: "preview", tier_code: tier.code, case_count: disputes.length, file_count: fileCount, readiness_score: readiness }).select("*").single();
  if (error) { console.error(error); return; }
  const links = ids.map((disputeId, position) => ({ pack_id: pack.id, dispute_id: disputeId, organization_id: workspaceState.organization.id, position }));
  const { error: linkError } = await studio.from("chargeback_pack_disputes").insert(links);
  if (linkError) { await studio.from("chargeback_packs").delete().eq("id", pack.id); console.error(linkError); return; }
  await refreshWorkspace();
  await openPack(pack.id);
}

async function openPack(packId) {
  const pack = workspaceState.packs.find((item) => item.id === packId); if (!pack) return;
  const ids = workspaceState.packLinks.filter((item) => item.pack_id === packId).sort((a, b) => a.position - b.position).map((item) => item.dispute_id);
  const disputes = ids.map((id) => workspaceState.disputes.find((item) => item.id === id)).filter(Boolean);
  const hydrated = [];
  for (const dispute of disputes) {
    const evidence = workspaceState.evidence.filter((item) => item.dispute_id === dispute.id);
    const files = [];
    for (const item of evidence) {
      const { data, error } = await studio.storage.from(EVIDENCE_BUCKET).download(item.storage_path);
      if (!error && data) files.push({ file: data, name: item.original_name, size: item.size_bytes, category: item.category, url: URL.createObjectURL(data) });
    }
    hydrated.push({ ...dispute, evidenceFiles: files });
  }
  workspaceState.activePackId = packId;
  activateView("builder");
  window.chargebackBuilder?.loadWorkspacePack(pack, hydrated);
}

async function markPackUnlocked(sessionId) {
  if (!workspaceState.activePackId) return;
  void sessionId;
  await refreshWorkspace();
}

window.chargebackWorkspace = {
  getSession: () => workspaceState.session,
  getOrganization: () => workspaceState.organization,
  getActivePackId: () => workspaceState.activePackId,
  markPackUnlocked,
  openPack,
  refresh: refreshWorkspace,
};

function bindWorkspaceEvents() {
  $$("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
  $$("[data-auth-cta]").forEach((button) => button.addEventListener("click", () => {
    setAuthMode("signup");
    $("#account")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }));
  $("#auth-form").addEventListener("submit", handleAuthSubmit);
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
  $$("[data-new-dispute]").forEach((button) => button.addEventListener("click", () => openDisputeDialog()));
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $("#dispute-dialog").close()));
  $("#dispute-form").addEventListener("submit", saveDispute);
  $("#sign-out").addEventListener("click", () => studio.auth.signOut());
  $("#mobile-menu").addEventListener("click", () => $("#workspace-shell").classList.toggle("menu-open"));
  $$("[data-filter]").forEach((button) => button.addEventListener("click", () => { workspaceState.filter = button.dataset.filter; $$("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button)); renderDisputes(); }));
  $("#select-all-disputes").addEventListener("change", (event) => $$('[data-select-dispute]').forEach((input) => { input.checked = event.currentTarget.checked; }));
  $("#create-pack-from-list").addEventListener("click", createPackFromSelection);
  window.addEventListener("hashchange", () => activateView(location.hash.replace("#", "")));
}

async function initializeWorkspace() {
  bindWorkspaceEvents(); setAuthMode("signin");
  if (!studio) { showAuth(); $("#auth-message").textContent = "The account service could not be loaded. Check your connection and refresh."; return; }
  const { data: { session } } = await studio.auth.getSession();
  if (session) await loadWorkspace(session); else showAuth();
  studio.auth.onAuthStateChange((event, nextSession) => {
    if (event === "SIGNED_OUT" || !nextSession) showAuth();
    else if (["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(event)) void loadWorkspace(nextSession);
  });
}

void initializeWorkspace();
