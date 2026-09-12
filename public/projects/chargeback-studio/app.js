(() => {
const reasonConfig = {
  unrecognized: {
    label: "Payment not recognized",
    short: "Customer denies the charge",
    evidence: [
      ["order-record", "Order and payment record", "Order reference, timestamp, billing details, and payment status", true],
      ["customer-match", "Customer identity match", "A prior order, account login, matching address, or verified contact", true],
      ["fulfillment", "Fulfillment evidence", "Tracking, delivery confirmation, download log, or service access", true],
      ["communication", "Customer communication", "Messages that reference the purchase, product, or delivery", false],
      ["policy", "Checkout terms or policy", "The terms visible when the order was placed", false],
    ],
  },
  "not-received": {
    label: "Product not received",
    short: "Customer says the order did not arrive",
    evidence: [
      ["order-record", "Order and payment record", "Order reference, timestamp, items, and delivery address", true],
      ["tracking", "Carrier tracking", "Tracking number, carrier events, and final delivery status", true],
      ["delivery", "Delivery confirmation", "Delivery photo, signature, GPS event, or recipient confirmation", true],
      ["communication", "Customer communication", "Delivery updates or messages acknowledging receipt", false],
      ["shipping-policy", "Shipping policy", "The delivery terms visible when the order was placed", false],
    ],
  },
  "not-described": {
    label: "Product not as described",
    short: "Customer says the product differed from the listing",
    evidence: [
      ["listing", "Product listing", "Description, specifications, photos, and options shown at purchase", true],
      ["order-record", "Order configuration", "The exact variant, customization, or service the customer chose", true],
      ["fulfillment", "What was delivered", "Packing photo, final deliverable, serial number, or completion record", true],
      ["approval", "Customer approval", "Proof the customer approved a proof, mockup, milestone, or result", false],
      ["resolution", "Resolution attempt", "Messages offering support, return, replacement, or correction", false],
    ],
  },
  duplicate: {
    label: "Duplicate charge",
    short: "Customer reports being charged twice",
    evidence: [
      ["transactions", "Transaction records", "Identifiers, timestamps, and amounts for the relevant payments", true],
      ["orders", "Separate order records", "Proof that each charge maps to a different order or renewal", true],
      ["receipts", "Customer receipts", "Receipts or invoices showing what each payment covered", true],
      ["communication", "Customer communication", "Messages explaining the charges or resolving an actual duplicate", false],
      ["refund", "Refund record", "Proof of a refund when one of the charges was reversed", false],
    ],
  },
};

const PAYMENT_CONFIG_ENDPOINT = "https://intelligentdecisions.io/api/stripe/payment-config";
const PAYMENT_INTENT_ENDPOINT = "https://intelligentdecisions.io/api/stripe/payment-intent";
const ENTITLEMENT_ENDPOINT = "https://intelligentdecisions.io/api/stripe/entitlement";
const BATCH_ID_KEY = "chargeback_studio_batch_id";
const CHECKOUT_SESSION_KEY = "chargeback_studio_checkout_session";
const PAYMENT_INTENT_KEY = "chargeback_studio_payment_intent";
const DATABASE_NAME = "chargeback-studio-local";
const DATABASE_VERSION = 1;
const TIER_CONFIG = [
  { code: "single", label: "Starter", maxCases: Number.MAX_SAFE_INTEGER, maxFiles: 20, price: 29 },
  { code: "multi", label: "Growth", maxCases: Number.MAX_SAFE_INTEGER, maxFiles: 50, price: 49 },
  { code: "volume", label: "Volume", maxCases: Number.MAX_SAFE_INTEGER, maxFiles: 100, price: 79 },
];

const createId = () => crypto.randomUUID();
const emptyDetails = () => ({
  merchantName: "",
  orderReference: "",
  processor: "Shopify Payments",
  amount: "",
  currency: "USD",
  orderDate: "",
  fulfillmentDate: "",
  disputeDate: "",
  deadline: "",
  summary: "",
  contactDate: "",
  contactNote: "",
});

function getOrCreateBatchId() {
  const existing = localStorage.getItem(BATCH_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = createId();
  localStorage.setItem(BATCH_ID_KEY, created);
  return created;
}

const state = {
  step: 1,
  reason: "",
  details: emptyDetails(),
  selectedEvidence: new Set(),
  files: [],
  cases: [],
  batchId: getOrCreateBatchId(),
  activeCaseId: createId(),
  entitlement: null,
  selectedTierCode: null,
  demo: false,
};

const paymentFlow = {
  stripe: null,
  elements: null,
  addressElement: null,
  paymentElement: null,
  intent: null,
  tier: null,
  metrics: null,
  packId: null,
};

const wizard = document.querySelector("#wizard-stage");
const stepCount = document.querySelector("#step-count");
const progressBar = document.querySelector("#progress-bar");
const builder = document.querySelector("#case-builder");

const escapeHTML = (value = "") =>
  String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);

const todayISO = () => new Date().toISOString().slice(0, 10);

const formatDate = (value) => {
  if (!value) return "Not provided";
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
};

const formatMoney = (details = state.details) => {
  const amount = Number(details.amount);
  if (!Number.isFinite(amount)) return `${details.amount || "—"} ${details.currency}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: details.currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${details.currency}`;
  }
};

const formatBytes = (bytes = 0) => bytes > 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

let databasePromise;

function openDatabase() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("batches")) {
        database.createObjectStore("batches", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.warn("Chargeback Studio local cache is unavailable", error);
    return null;
  });
  return databasePromise;
}

function stripFileForStorage(entry) {
  return {
    file: entry.file || null,
    name: entry.name,
    size: entry.size,
    category: entry.category,
    demo: entry.demo === true,
  };
}

function hydrateFile(entry) {
  return {
    ...entry,
    url: entry.file ? URL.createObjectURL(entry.file) : null,
  };
}

function serializeCase(caseRecord) {
  return {
    ...caseRecord,
    details: { ...caseRecord.details },
    selectedEvidence: [...caseRecord.selectedEvidence],
    files: caseRecord.files.map(stripFileForStorage),
  };
}

function hydrateCase(caseRecord) {
  return {
    ...caseRecord,
    details: { ...emptyDetails(), ...caseRecord.details },
    selectedEvidence: [...(caseRecord.selectedEvidence || [])],
    files: (caseRecord.files || []).map(hydrateFile),
  };
}

async function persistBatch() {
  const database = await openDatabase();
  if (!database) return;
  const record = {
    id: state.batchId,
    updatedAt: new Date().toISOString(),
    cases: state.cases.map(serializeCase),
  };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("batches", "readwrite");
    transaction.objectStore("batches").put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function restoreBatch() {
  const database = await openDatabase();
  if (!database) return;
  const record = await new Promise((resolve, reject) => {
    const transaction = database.transaction("batches", "readonly");
    const request = transaction.objectStore("batches").get(state.batchId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  if (!record?.cases?.length) return;
  state.cases = record.cases.map(hydrateCase);
  loadCaseIntoDraft(state.cases[state.cases.length - 1]);
}

function currentCaseSnapshot() {
  return {
    id: state.activeCaseId,
    reason: state.reason,
    details: { ...state.details },
    selectedEvidence: [...state.selectedEvidence],
    files: state.files.map((entry) => ({ ...entry })),
    score: getScore(),
    updatedAt: new Date().toISOString(),
  };
}

function upsertCurrentCase() {
  if (state.demo || !state.reason || !state.details.orderReference) return null;
  const snapshot = currentCaseSnapshot();
  const existingIndex = state.cases.findIndex((entry) => entry.id === snapshot.id);
  if (existingIndex >= 0) state.cases[existingIndex] = snapshot;
  else state.cases.push(snapshot);
  void persistBatch();
  renderCheckoutPanel();
  return snapshot;
}

function getBatchMetrics() {
  return {
    caseCount: state.cases.length,
    fileCount: state.cases.reduce((total, entry) => total + entry.files.length, 0),
  };
}

function getTier(caseCount, fileCount) {
  return TIER_CONFIG.find((tier) => caseCount <= tier.maxCases && fileCount <= tier.maxFiles) || null;
}

function getCurrentTier() {
  const metrics = getBatchMetrics();
  return getTier(metrics.caseCount, metrics.fileCount);
}

function getCheckoutTier(metrics = getBatchMetrics()) {
  const selected = TIER_CONFIG.find((tier) => tier.code === state.selectedTierCode);
  if (selected && metrics.caseCount <= selected.maxCases && metrics.fileCount <= selected.maxFiles) return selected;
  return getTier(metrics.caseCount, metrics.fileCount);
}

function entitlementCoversBatch() {
  if (!state.entitlement?.unlocked || state.entitlement.batchId !== state.batchId) return false;
  const metrics = getBatchMetrics();
  return metrics.caseCount <= state.entitlement.maxCases && metrics.fileCount <= state.entitlement.maxFiles;
}

function clearDraft() {
  state.files.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
  state.step = 1;
  state.reason = "";
  state.details = emptyDetails();
  state.selectedEvidence = new Set();
  state.files = [];
  state.activeCaseId = createId();
  state.demo = false;
}

function loadCaseIntoDraft(caseRecord) {
  state.files.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
  state.activeCaseId = caseRecord.id;
  state.reason = caseRecord.reason;
  state.details = { ...emptyDetails(), ...caseRecord.details };
  state.selectedEvidence = new Set(caseRecord.selectedEvidence || []);
  state.files = caseRecord.files.map((entry) => ({
    ...entry,
    url: entry.file ? URL.createObjectURL(entry.file) : entry.url || null,
  }));
  state.demo = false;
  state.step = 4;
}

function startAnotherCase() {
  upsertCurrentCase();
  clearDraft();
  render();
  document.querySelector("#case-builder").scrollIntoView({ behavior: "smooth", block: "start" });
}

function editCase(caseId) {
  const caseRecord = state.cases.find((entry) => entry.id === caseId);
  if (!caseRecord) return;
  loadCaseIntoDraft(caseRecord);
  render();
  document.querySelector("#case-builder").scrollIntoView({ behavior: "smooth", block: "start" });
}

function removeCase(caseId) {
  const index = state.cases.findIndex((entry) => entry.id === caseId);
  if (index < 0) return;
  const [removed] = state.cases.splice(index, 1);
  removed.files.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
  if (state.activeCaseId === caseId) clearDraft();
  void persistBatch();
  render();
  renderCheckoutPanel();
}

function render() {
  stepCount.innerHTML = `${state.step} <small>of 4</small>`;
  progressBar.style.width = `${state.step * 25}%`;
  builder.classList.toggle("is-packet-ready", state.step === 4);

  if (state.step === 1) renderReasonStep();
  if (state.step === 2) renderDetailsStep();
  if (state.step === 3) renderEvidenceStep();
  if (state.step === 4) renderReviewStep();
  renderCheckoutPanel();
}

function renderReasonStep() {
  wizard.innerHTML = `
    <p class="step-kicker">First, identify the claim</p>
    <h2 id="builder-title">Why was the payment disputed?</h2>
    <div class="reason-grid" role="radiogroup" aria-label="Dispute reason">
      ${Object.entries(reasonConfig).map(([key, reason], index) => `
        <button type="button" class="reason-option" data-reason="${key}" role="radio" aria-checked="${state.reason === key}">
          <span class="reason-icon">0${index + 1}</span>
          <span><strong>${reason.label.replace("Payment ", "")}</strong><small>${reason.short}</small></span>
        </button>
      `).join("")}
    </div>
    <button class="primary-button" id="continue-reason" type="button" ${state.reason ? "" : "disabled"}>
      Continue with this reason <span aria-hidden="true">→</span>
    </button>
  `;

  const reasonButtons = [...wizard.querySelectorAll(".reason-option")];
  const continueButton = wizard.querySelector("#continue-reason");
  reasonButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.reason = button.dataset.reason;
      state.selectedEvidence.clear();
      reasonButtons.forEach((option) => option.setAttribute("aria-checked", String(option === button)));
      continueButton.disabled = false;
    });
  });
  continueButton.addEventListener("click", () => {
    state.step = 2;
    render();
  });
}

function renderDetailsStep() {
  const details = state.details;
  wizard.innerHTML = `
    <p class="step-kicker">Case details</p>
    <h2 id="builder-title">Build the factual spine.</h2>
    <p class="step-intro">Use the same references and dates shown in your processor dashboard. Optional fields can be added later.</p>
    <form id="details-form">
      <div class="field-grid">
        <div class="field">
          <label for="merchant-name">Business name</label>
          <input id="merchant-name" name="merchantName" value="${escapeHTML(details.merchantName)}" autocomplete="organization" required />
        </div>
        <div class="field">
          <label for="order-reference">Order reference</label>
          <input id="order-reference" name="orderReference" value="${escapeHTML(details.orderReference)}" placeholder="#1087" required />
        </div>
        <div class="field">
          <label for="processor">Payment processor</label>
          <select id="processor" name="processor">
            ${["Shopify Payments", "Stripe", "PayPal", "Square", "Other"].map((processor) => `<option ${details.processor === processor ? "selected" : ""}>${processor}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="amount">Disputed amount</label>
          <div class="input-prefix"><span>$</span><input id="amount" name="amount" value="${escapeHTML(details.amount)}" type="number" min="0" step="0.01" placeholder="184.00" required /></div>
        </div>
        <div class="field">
          <label for="currency">Currency</label>
          <select id="currency" name="currency">
            ${["USD", "CAD", "GBP", "EUR", "AUD"].map((currency) => `<option ${details.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="order-date">Order date</label>
          <input id="order-date" name="orderDate" value="${details.orderDate}" type="date" max="${todayISO()}" required />
        </div>
        <div class="field">
          <label for="fulfillment-date">Fulfillment date <span>(optional)</span></label>
          <input id="fulfillment-date" name="fulfillmentDate" value="${details.fulfillmentDate}" type="date" />
        </div>
        <div class="field">
          <label for="dispute-date">Dispute opened <span>(optional)</span></label>
          <input id="dispute-date" name="disputeDate" value="${details.disputeDate}" type="date" />
        </div>
        <div class="field">
          <label for="deadline">Response deadline <span>(optional)</span></label>
          <input id="deadline" name="deadline" value="${details.deadline}" type="date" />
        </div>
        <div class="field span-2">
          <label for="summary">Factual summary</label>
          <textarea id="summary" name="summary" maxlength="900" placeholder="Describe what was purchased, what you delivered, and what the records show. Avoid assumptions about the customer’s intent." required>${escapeHTML(details.summary)}</textarea>
        </div>
        <div class="field">
          <label for="contact-date">Customer contact date <span>(optional)</span></label>
          <input id="contact-date" name="contactDate" value="${details.contactDate}" type="date" />
        </div>
        <div class="field">
          <label for="contact-note">Contact outcome <span>(optional)</span></label>
          <input id="contact-note" name="contactNote" value="${escapeHTML(details.contactNote)}" placeholder="Customer confirmed delivery by email" />
        </div>
      </div>
      <div class="builder-actions">
        <button class="secondary-button" type="button" id="back-to-reason">Back</button>
        <button class="primary-button" type="submit">Collect evidence <span aria-hidden="true">→</span></button>
      </div>
    </form>
  `;

  wizard.querySelector("#back-to-reason").addEventListener("click", () => {
    captureDetails(wizard.querySelector("#details-form"));
    state.step = 1;
    render();
  });

  wizard.querySelector("#details-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    captureDetails(event.currentTarget);
    state.step = 3;
    render();
  });
}

function captureDetails(form) {
  const formData = new FormData(form);
  Object.keys(state.details).forEach((key) => {
    state.details[key] = String(formData.get(key) || "").trim();
  });
}

function renderEvidenceStep() {
  const evidence = reasonConfig[state.reason].evidence;
  wizard.innerHTML = `
    <p class="step-kicker">Evidence collection</p>
    <h2 id="builder-title">Show what the records prove.</h2>
    <p class="step-intro">Check the records you have, then attach image exhibits. Screenshots are processed only in this browser.</p>
    <div class="evidence-list">
      ${evidence.map(([key, label, help, core]) => `
        <label class="evidence-check">
          <input type="checkbox" value="${key}" ${state.selectedEvidence.has(key) ? "checked" : ""} />
          <span class="fake-check" aria-hidden="true"></span>
          <span><strong>${label}</strong><small>${help}</small></span>
          <small>${core ? "core" : "helpful"}</small>
        </label>
      `).join("")}
    </div>
    <label class="upload-zone" id="upload-zone">
      <input id="evidence-files" type="file" accept="image/png,image/jpeg,image/webp" multiple />
      <span><strong>Choose screenshots or drop them here</strong><small>PNG, JPG, or WebP · up to 100 images per case · 7 MB each</small></span>
    </label>
    <p class="upload-message" id="upload-message" role="status"></p>
    <div class="file-list" id="file-list">${renderFileRows()}</div>
    <div class="builder-actions">
      <button class="secondary-button" type="button" id="back-to-details">Back</button>
      <button class="primary-button" id="review-case" type="button">Review readiness <span aria-hidden="true">→</span></button>
    </div>
  `;

  wizard.querySelectorAll(".evidence-check input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedEvidence.add(input.value);
      else state.selectedEvidence.delete(input.value);
    });
  });

  const fileInput = wizard.querySelector("#evidence-files");
  const uploadZone = wizard.querySelector("#upload-zone");
  fileInput.addEventListener("change", () => addFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((type) => uploadZone.addEventListener(type, (event) => {
    event.preventDefault();
    uploadZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => uploadZone.addEventListener(type, (event) => {
    event.preventDefault();
    uploadZone.classList.remove("is-dragging");
  }));
  uploadZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  bindFileRows();

  wizard.querySelector("#back-to-details").addEventListener("click", () => {
    state.step = 2;
    render();
  });
  wizard.querySelector("#review-case").addEventListener("click", () => {
    state.step = 4;
    render();
  });
}

function addFiles(fileList) {
  const message = wizard.querySelector("#upload-message");
  const incoming = [...fileList];
  const errors = [];
  for (const file of incoming) {
    if (state.files.length >= 100) {
      errors.push("Only the first 100 images can be included in one case.");
      break;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      errors.push(`${file.name} is not a supported image.`);
      continue;
    }
    if (file.size > 7 * 1024 * 1024) {
      errors.push(`${file.name} is larger than 7 MB.`);
      continue;
    }
    const duplicate = state.files.some((entry) => entry.name === file.name && entry.size === file.size);
    if (duplicate) continue;
    state.files.push({
      file,
      name: file.name,
      size: file.size,
      category: reasonConfig[state.reason].evidence[0][0],
      url: URL.createObjectURL(file),
      demo: false,
    });
  }
  message.textContent = errors.join(" ");
  wizard.querySelector("#file-list").innerHTML = renderFileRows();
  bindFileRows();
}

function renderFileRows() {
  if (!state.files.length) return "";
  const categories = reasonConfig[state.reason].evidence;
  return state.files.map((entry, index) => `
    <div class="file-row" data-index="${index}">
      ${entry.url ? `<img class="file-thumb" src="${entry.url}" alt="" />` : `<span class="file-thumb" aria-hidden="true"></span>`}
      <span class="file-name"><strong>${escapeHTML(entry.name)}</strong><small>${formatBytes(entry.size)}</small></span>
      <select aria-label="Evidence type for ${escapeHTML(entry.name)}">
        ${categories.map(([key, label]) => `<option value="${key}" ${entry.category === key ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      <button class="remove-file" type="button" aria-label="Remove ${escapeHTML(entry.name)}">×</button>
    </div>
  `).join("");
}

function bindFileRows() {
  wizard.querySelectorAll(".file-row").forEach((row) => {
    const index = Number(row.dataset.index);
    row.querySelector("select").addEventListener("change", (event) => {
      state.files[index].category = event.target.value;
      state.selectedEvidence.add(event.target.value);
    });
    row.querySelector(".remove-file").addEventListener("click", () => {
      const [removed] = state.files.splice(index, 1);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      wizard.querySelector("#file-list").innerHTML = renderFileRows();
      bindFileRows();
    });
  });
}

function getScore() {
  const evidence = reasonConfig[state.reason].evidence;
  const core = evidence.filter((item) => item[3]);
  const selectedCore = core.filter((item) => state.selectedEvidence.has(item[0])).length;
  const evidencePoints = core.length ? (selectedCore / core.length) * 70 : 0;
  const filePoints = Math.min(state.files.length / 3, 1) * 20;
  const detailPoints = [state.details.orderDate, state.details.summary, state.details.amount].filter(Boolean).length / 3 * 10;
  return Math.round(evidencePoints + filePoints + detailPoints);
}

function getMissingCore() {
  return reasonConfig[state.reason].evidence.filter((item) => item[3] && !state.selectedEvidence.has(item[0]));
}

function renderReviewStep() {
  const score = getScore();
  const missing = getMissingCore();
  if (!state.demo) upsertCurrentCase();
  const metrics = getBatchMetrics();
  const tier = getTier(metrics.caseCount, metrics.fileCount);
  const assessment = score >= 85
    ? ["Strongly organized", "Your core records are represented. Confirm every statement and exhibit before submitting."]
    : score >= 60
      ? ["Good foundation", "The case is taking shape. Add the missing core records if they exist."]
      : ["Needs more support", "The packet can still be generated, but the missing records may make the story harder to verify."];

  const batchMarkup = state.demo ? `
    <div class="batch-summary sample-batch">
      <strong>Sample case</strong>
      <span>This demonstration does not count toward your batch.</span>
    </div>
  ` : `
    <div class="batch-summary">
      <div class="batch-summary-head">
        <span><strong>Your batch</strong><small>${metrics.caseCount} case${metrics.caseCount === 1 ? "" : "s"} · ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}</small></span>
        <span class="batch-tier">${tier ? `${tier.label} · $${tier.price}` : "Subscription"}</span>
      </div>
      <div class="batch-case-list">
        ${state.cases.map((entry) => `
          <div class="batch-case-row">
            <span><strong>${escapeHTML(entry.details.orderReference)}</strong><small>${escapeHTML(reasonConfig[entry.reason]?.label || "Dispute")} · ${entry.files.length} file${entry.files.length === 1 ? "" : "s"} · ${entry.score} readiness</small></span>
            <span class="batch-case-actions">
              <button type="button" data-edit-case="${entry.id}">Edit</button>
              <button type="button" data-remove-case="${entry.id}" aria-label="Remove ${escapeHTML(entry.details.orderReference)} from the batch">Remove</button>
            </span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  wizard.innerHTML = `
    <p class="step-kicker">Readiness review</p>
    <h2 id="builder-title">Check the case before you finalize.</h2>
    <div class="review-grid">
      <div class="score-ring" style="--score: ${score}%"><span>${score}<small>readiness</small></span></div>
      <div class="review-summary"><h3>${assessment[0]}</h3><p>${assessment[1]}</p></div>
    </div>
    ${missing.length ? `
      <div class="missing-box"><strong>Core records not yet marked</strong><ul>${missing.map((item) => `<li>${item[1]}</li>`).join("")}</ul></div>
    ` : ""}
    <dl class="case-review">
      <div><dt>Claim</dt><dd>${reasonConfig[state.reason].label}</dd></div>
      <div><dt>Order</dt><dd>${escapeHTML(state.details.orderReference)}</dd></div>
      <div><dt>Exhibits</dt><dd>${state.files.length} image${state.files.length === 1 ? "" : "s"}</dd></div>
    </dl>
    ${batchMarkup}
    <div class="batch-builder-actions">
      <button class="secondary-button" type="button" id="back-to-evidence">Back</button>
      <button class="secondary-button" id="add-another-case" type="button">Add another case</button>
      <button class="primary-button" id="preview-batch" type="button">Preview marked pack <span aria-hidden="true">→</span></button>
      ${state.demo ? "" : `<button class="text-button pricing-jump" id="continue-to-pricing" type="button">Review price and unlock</button>`}
    </div>
    <p class="demo-note">The readiness score measures completeness, not the chance of winning. Nothing is submitted automatically.</p>
  `;

  wizard.querySelector("#back-to-evidence").addEventListener("click", () => {
    state.step = 3;
    render();
  });
  wizard.querySelector("#preview-batch").addEventListener("click", showPacket);
  wizard.querySelector("#add-another-case").addEventListener("click", startAnotherCase);
  wizard.querySelector("#continue-to-pricing")?.addEventListener("click", () => {
    document.querySelector("#pricing").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  wizard.querySelectorAll("[data-edit-case]").forEach((button) => {
    button.addEventListener("click", () => editCase(button.dataset.editCase));
  });
  wizard.querySelectorAll("[data-remove-case]").forEach((button) => {
    button.addEventListener("click", () => removeCase(button.dataset.removeCase));
  });
}

function buildTimeline(details = state.details) {
  const entries = [
    details.orderDate && [details.orderDate, `Order ${details.orderReference} was placed.`],
    details.fulfillmentDate && [details.fulfillmentDate, "The order was marked fulfilled."],
    details.contactDate && [details.contactDate, details.contactNote || "Customer contact was recorded."],
    details.disputeDate && [details.disputeDate, "The payment dispute was opened."],
    details.deadline && [details.deadline, "Current response deadline."],
  ].filter(Boolean);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

function previewWatermarkMarkup(unlocked) {
  if (unlocked) return "";
  return `<div class="preview-watermark" aria-hidden="true"><span>Chargeback Studio</span><small>Preview · Not for submission</small></div>`;
}

function packetPage(content, unlocked, extraClass = "") {
  return `<article class="packet-page ${extraClass} ${unlocked ? "" : "is-preview"}">${previewWatermarkMarkup(unlocked)}${content}</article>`;
}

function renderCasePages(caseRecord, unlocked) {
  const caseId = `EL-${(caseRecord.details.orderReference || "CASE").replace(/[^a-z0-9]/gi, "").toUpperCase()}`;
  const selected = new Set(caseRecord.selectedEvidence || []);
  const selectedLabels = reasonConfig[caseRecord.reason].evidence.filter((item) => selected.has(item[0]));
  const timeline = buildTimeline(caseRecord.details);
  const fileRows = caseRecord.files.length
    ? caseRecord.files.map((entry, index) => {
      const label = reasonConfig[caseRecord.reason].evidence.find((item) => item[0] === entry.category)?.[1] || "Other evidence";
      return `<tr><td>Exhibit ${index + 1}</td><td>${escapeHTML(label)}</td><td>${escapeHTML(entry.name)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="3">No image exhibits attached.</td></tr>`;

  const summaryPage = packetPage(`
    <header class="packet-head"><span>Chargeback Studio / Dispute response</span><span>${escapeHTML(caseId)}</span></header>
    <h1>Evidence packet</h1>
    <p class="packet-subtitle">${unlocked ? "Final pack" : "Marked preview"} · ${escapeHTML(caseRecord.details.merchantName)}</p>
    <dl class="packet-facts">
      <div><dt>Order reference</dt><dd>${escapeHTML(caseRecord.details.orderReference)}</dd></div>
      <div><dt>Dispute reason</dt><dd>${escapeHTML(reasonConfig[caseRecord.reason].label)}</dd></div>
      <div><dt>Disputed amount</dt><dd>${escapeHTML(formatMoney(caseRecord.details))}</dd></div>
      <div><dt>Processor</dt><dd>${escapeHTML(caseRecord.details.processor)}</dd></div>
      <div><dt>Order date</dt><dd>${formatDate(caseRecord.details.orderDate)}</dd></div>
      <div><dt>Response deadline</dt><dd>${formatDate(caseRecord.details.deadline)}</dd></div>
    </dl>
    <h2>Merchant’s factual summary</h2>
    <p class="packet-statement">${escapeHTML(caseRecord.details.summary)}</p>
    <h2>Chronology</h2>
    <ol class="packet-timeline">
      ${timeline.map(([date, copy]) => `<li><time datetime="${date}">${formatDate(date)}</time><p>${escapeHTML(copy)}</p></li>`).join("") || `<li><p>No dated events supplied.</p></li>`}
    </ol>
    <h2>Evidence supplied</h2>
    <p>${selectedLabels.length ? selectedLabels.map((item) => escapeHTML(item[1])).join(" · ") : "No evidence categories marked."}</p>
    <h2>Exhibit index</h2>
    <table class="packet-index"><thead><tr><th>Reference</th><th>Evidence type</th><th>File</th></tr></thead><tbody>${fileRows}</tbody></table>
    <p class="packet-disclaimer">Chargeback Studio organizes merchant-supplied information. It does not verify evidence, provide legal or financial advice, contact a processor, submit a response, or guarantee an outcome. Review this packet and your processor’s current requirements before submission.</p>
  `, unlocked, "case-summary-page");

  const exhibits = caseRecord.files.filter((entry) => entry.url).map((entry, index) => {
    const label = reasonConfig[caseRecord.reason].evidence.find((item) => item[0] === entry.category)?.[1] || "Other evidence";
    return packetPage(`
      <header class="packet-head"><span>Exhibit ${index + 1}</span><span>${escapeHTML(caseId)}</span></header>
      <h2>${escapeHTML(label)}</h2>
      <img src="${entry.url}" alt="Uploaded evidence: ${escapeHTML(entry.name)}" />
      <p class="exhibit-caption">Original file: ${escapeHTML(entry.name)}</p>
    `, unlocked, "exhibit");
  }).join("");

  return summaryPage + exhibits;
}

function showPacket() {
  if (!state.demo) upsertCurrentCase();
  let packet = document.querySelector("#packet-view");
  if (!packet) {
    packet = document.createElement("section");
    packet.id = "packet-view";
    packet.className = "packet-view";
    document.body.append(packet);
  }

  const cases = state.demo ? [currentCaseSnapshot()] : state.cases;
  if (!cases.length) return;
  const unlocked = !state.demo && entitlementCoversBatch();
  const metrics = state.demo
    ? { caseCount: 1, fileCount: state.files.length }
    : getBatchMetrics();
  const batchCover = cases.length > 1 ? packetPage(`
    <header class="packet-head"><span>Chargeback Studio / Response pack</span><span>${escapeHTML(state.batchId.slice(0, 8).toUpperCase())}</span></header>
    <h1>Dispute batch</h1>
    <p class="packet-subtitle">${unlocked ? "Final pack" : "Marked preview"} · ${cases.length} cases · ${metrics.fileCount} files</p>
    <h2>Case index</h2>
    <table class="packet-index"><thead><tr><th>Case</th><th>Dispute reason</th><th>Files</th><th>Readiness</th></tr></thead><tbody>
      ${cases.map((entry, index) => `<tr><td>${index + 1}. ${escapeHTML(entry.details.orderReference)}</td><td>${escapeHTML(reasonConfig[entry.reason].label)}</td><td>${entry.files.length}</td><td>${entry.score}</td></tr>`).join("")}
    </tbody></table>
    <p class="packet-disclaimer">Each case begins on a new page and must be matched to the correct dispute in your processor dashboard.</p>
  `, unlocked, "batch-cover") : "";

  packet.innerHTML = `
    <div class="packet-toolbar">
      <span>${unlocked ? "Clean pack unlocked" : "Marked preview"}</span>
      <button type="button" id="print-packet">${unlocked ? "Print / save clean PDF" : "Print marked preview"}</button>
      <button type="button" id="edit-packet">Return to cases</button>
      ${unlocked ? "" : `<button type="button" id="unlock-packet">Choose a tier</button>`}
    </div>
    ${batchCover}
    ${cases.map((caseRecord) => renderCasePages(caseRecord, unlocked)).join("")}
  `;

  packet.setAttribute("aria-hidden", "false");
  document.body.classList.add("packet-open");
  window.scrollTo(0, 0);
  packet.querySelector("#print-packet").addEventListener("click", () => window.print());
  packet.querySelector("#edit-packet").addEventListener("click", () => closePacket("#case-builder"));
  packet.querySelector("#unlock-packet")?.addEventListener("click", () => closePacket("#pricing"));
}

function closePacket(targetSelector) {
  document.querySelector("#packet-view")?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("packet-open");
  document.querySelector(targetSelector)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function loadDemoCase() {
  state.files.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
  state.reason = "not-received";
  state.details = {
    merchantName: "Northline Goods",
    orderReference: "#1087",
    processor: "Shopify Payments",
    amount: "184.00",
    currency: "USD",
    orderDate: "2026-05-04",
    fulfillmentDate: "2026-05-06",
    disputeDate: "2026-05-18",
    deadline: "2026-05-30",
    summary: "Order #1087 contained one made-to-order leather weekender. The order was fulfilled to the delivery address supplied at checkout. Carrier records show the parcel was accepted on May 6 and marked delivered on May 9. The customer later filed a product-not-received dispute.",
    contactDate: "2026-05-10",
    contactNote: "Delivery follow-up was sent to the customer email on the order.",
  };
  state.selectedEvidence = new Set(["order-record", "tracking", "delivery", "communication"]);
  state.files = [
    { name: "order-1087.png", size: 482000, category: "order-record", url: null, demo: true },
    { name: "carrier-tracking.png", size: 615000, category: "tracking", url: null, demo: true },
    { name: "delivery-confirmation.jpg", size: 721000, category: "delivery", url: null, demo: true },
    { name: "customer-follow-up.png", size: 334000, category: "communication", url: null, demo: true },
  ];
  state.demo = true;
  state.step = 4;
  render();
  document.querySelector("#case-builder").scrollIntoView({ behavior: "smooth", block: "center" });
}

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const validReasons = Object.keys(reasonConfig);
  try {
    void Promise.resolve(context.registerTool({
      name: "prepare_chargeback_case",
      title: "Prepare chargeback case",
      description: "Stage the factual details for a chargeback case and open Chargeback Studio's evidence-collection step. This does not submit the dispute.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", enum: validReasons },
          merchantName: { type: "string", minLength: 1 },
          orderReference: { type: "string", minLength: 1 },
          processor: { type: "string", minLength: 1 },
          amount: { type: "string", minLength: 1 },
          orderDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          disputeDeadline: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          summary: { type: "string", minLength: 1 },
        },
        required: ["reason", "merchantName", "orderReference", "processor", "amount", "orderDate", "summary"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        if (!input || typeof input !== "object" || !validReasons.includes(input.reason)) throw new Error("A supported dispute reason is required.");
        for (const field of ["merchantName", "orderReference", "processor", "amount", "orderDate", "summary"]) {
          if (typeof input[field] !== "string" || !input[field].trim()) throw new Error(`${field} is required.`);
        }
        state.reason = input.reason;
        state.details.merchantName = input.merchantName.trim();
        state.details.orderReference = input.orderReference.trim();
        state.details.processor = input.processor.trim();
        state.details.amount = input.amount.trim();
        state.details.orderDate = input.orderDate;
        state.details.deadline = input.disputeDeadline || "";
        state.details.summary = input.summary.trim();
        state.step = 3;
        state.demo = false;
        state.selectedEvidence.clear();
        render();
        document.querySelector("#case-builder").scrollIntoView({ behavior: "smooth", block: "start" });
        return { status: "staged", step: "evidence", orderReference: state.details.orderReference, reason: state.reason };
      },
    })).catch(() => {});
  } catch {
    // Unsupported or partial WebMCP implementations should not interrupt the visible workflow.
  }
}

function renderCheckoutPanel() {
  const panel = document.querySelector("#batch-checkout-panel");
  if (!panel) return;
  const metrics = getBatchMetrics();
  const minimumTier = getTier(metrics.caseCount, metrics.fileCount);
  const selectedTier = TIER_CONFIG.find((candidate) => candidate.code === state.selectedTierCode);
  if (selectedTier && metrics.fileCount > selectedTier.maxFiles) state.selectedTierCode = null;
  const tier = metrics.caseCount || state.selectedTierCode ? getCheckoutTier(metrics) : null;
  document.querySelectorAll("[data-tier-card]").forEach((card) => {
    card.classList.toggle("is-active", tier?.code === card.dataset.tierCard);
    card.setAttribute("aria-pressed", String(tier?.code === card.dataset.tierCard));
  });

  if (!metrics.caseCount) {
    if (tier) {
      panel.innerHTML = `
        <strong>${tier.label} selected · $${tier.price} USD.</strong>
        <span>Add one or more disputes with up to ${tier.maxFiles} files total. You will only pay when you unlock the clean pack.</span>
        <button class="purchase-button" id="start-tier-build" type="button">Start this pack <span aria-hidden="true">→</span></button>
      `;
      panel.querySelector("#start-tier-build").addEventListener("click", () => {
        document.querySelector("#case-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.requestAnimationFrame(() => wizard.querySelector("button, input, select, textarea")?.focus());
      });
    } else {
      panel.innerHTML = `<strong>Choose a tier or build your first case.</strong><span>Your readiness score and marked preview are free.</span>`;
    }
    return;
  }

  if (!minimumTier) {
    panel.innerHTML = `
      <strong>This volume is ready for a Chargeback Studio subscription.</strong>
      <span>${metrics.caseCount} cases · ${metrics.fileCount} files. Subscription pricing begins above 100 files.</span>
      <a class="purchase-button" href="mailto:bhall@intelligentdecisions.io?subject=Chargeback%20Studio%20subscription">Request subscription pricing <span aria-hidden="true">→</span></a>
    `;
    return;
  }

  if (entitlementCoversBatch()) {
    panel.innerHTML = `
      <strong>Clean ${tier.label.toLowerCase()} pack unlocked.</strong>
      <span>${metrics.caseCount} case${metrics.caseCount === 1 ? "" : "s"} · ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}</span>
      <button class="purchase-button" id="open-clean-pack" type="button">Open clean pack <span aria-hidden="true">→</span></button>
    `;
    panel.querySelector("#open-clean-pack").addEventListener("click", showPacket);
    return;
  }

  panel.innerHTML = `
    <strong>${tier.label} ${state.selectedTierCode ? "selected" : "fits this batch"}.</strong>
    <span>${metrics.caseCount} case${metrics.caseCount === 1 ? "" : "s"} · ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"} · $${tier.price} USD</span>
    <button class="purchase-button" id="start-checkout" type="button">Enter payment details · $${tier.price} <span aria-hidden="true">→</span></button>
    <small>One-time full payment · Final tax is shown before you pay</small>
  `;
  panel.querySelector("#start-checkout").addEventListener("click", startCheckout);
}

async function startCheckout() {
  upsertCurrentCase();
  const metrics = getBatchMetrics();
  const tier = getCheckoutTier(metrics);
  if (!tier) return;
  const button = document.querySelector("#start-checkout");
  if (button) {
    button.disabled = true;
    button.textContent = "Loading secure payment…";
  }

  try {
    await persistBatch();
    const session = window.chargebackWorkspace?.getSession();
    const packId = window.chargebackWorkspace?.getActivePackId() || state.batchId;
    if (!session?.access_token || !packId) throw new Error("Sign in and open a saved response pack before payment.");
    if (typeof window.Stripe !== "function") throw new Error("The secure payment form could not be loaded.");
    state.batchId = packId;
    const response = await fetch(PAYMENT_CONFIG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${session.access_token}` },
      credentials: "omit",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.publishableKey) throw new Error(result.message || "Payment is unavailable.");

    closePaymentDialog();
    paymentFlow.stripe = window.Stripe(result.publishableKey);
    paymentFlow.tier = tier;
    paymentFlow.metrics = metrics;
    paymentFlow.packId = packId;
    paymentFlow.intent = null;
    paymentFlow.elements = paymentFlow.stripe.elements({
      mode: "payment",
      amount: tier.price * 100,
      currency: result.currency || "usd",
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#081420",
          colorText: "#081420",
          colorDanger: "#b7442d",
          borderRadius: "8px",
          fontFamily: "Manrope, system-ui, sans-serif",
        },
      },
    });
    paymentFlow.addressElement = paymentFlow.elements.create("address", { mode: "billing" });
    paymentFlow.paymentElement = paymentFlow.elements.create("payment", {
      layout: { type: "tabs", defaultCollapsed: false },
    });
    paymentFlow.addressElement.mount("#address-element");
    paymentFlow.paymentElement.mount("#payment-element");
    paymentFlow.addressElement.on("change", () => {
      if (paymentFlow.intent) resetPaymentReview();
    });

    const order = document.querySelector("#payment-order");
    if (order) {
      order.innerHTML = `<div><strong>${escapeHTML(tier.label)} response pack</strong><span>${metrics.caseCount} case${metrics.caseCount === 1 ? "" : "s"} · ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}</span></div><b>$${tier.price}.00</b>`;
    }
    document.querySelector("#payment-title").textContent = `Unlock ${tier.label.toLowerCase()} pack`;
    resetPaymentReview();
    document.querySelector("#payment-dialog")?.showModal();
  } catch (error) {
    console.error("Chargeback Studio payment preparation failed", error);
    if (button) {
      button.disabled = false;
      button.textContent = `Enter payment details · $${tier.price}`;
    }
    const panel = document.querySelector("#batch-checkout-panel");
    panel?.querySelector(".checkout-error")?.remove();
    if (panel) {
      const message = document.createElement("p");
      message.className = "checkout-error";
      message.textContent = error?.message || "Payment could not be started. Please try again.";
      panel.append(message);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = `Enter payment details · $${tier.price}`;
    }
  }
}

function formatPaymentAmount(amount, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(Number(amount || 0) / 100);
}

function setPaymentMessage(message, kind = "error") {
  const output = document.querySelector("#payment-message");
  if (!output) return;
  output.textContent = message || "";
  output.dataset.kind = kind;
}

function renderPaymentTotals(intent = null) {
  const totals = document.querySelector("#payment-totals");
  if (!totals || !paymentFlow.tier) return;
  const subtotal = intent?.amountSubtotal ?? paymentFlow.tier.price * 100;
  const currency = intent?.currency || "usd";
  if (!intent) {
    totals.innerHTML = `<div class="payment-total-row"><span>Pack</span><strong>${formatPaymentAmount(subtotal, currency)}</strong></div><div class="payment-total-row"><span>Tax</span><strong>Calculated from billing address</strong></div>`;
    return;
  }
  totals.innerHTML = `<div class="payment-total-row"><span>Pack</span><strong>${formatPaymentAmount(subtotal, currency)}</strong></div><div class="payment-total-row"><span>Tax</span><strong>${formatPaymentAmount(intent.amountTax, currency)}</strong></div><div class="payment-total-row"><span>Total due now</span><strong>${formatPaymentAmount(intent.amountTotal, currency)}</strong></div>`;
}

function resetPaymentReview() {
  paymentFlow.intent = null;
  renderPaymentTotals();
  setPaymentMessage("");
  const submit = document.querySelector("#submit-payment");
  if (submit) {
    submit.disabled = false;
    submit.textContent = "Calculate total";
  }
}

function closePaymentDialog() {
  const dialog = document.querySelector("#payment-dialog");
  paymentFlow.addressElement?.unmount();
  paymentFlow.paymentElement?.unmount();
  paymentFlow.stripe = null;
  paymentFlow.elements = null;
  paymentFlow.addressElement = null;
  paymentFlow.paymentElement = null;
  paymentFlow.intent = null;
  paymentFlow.tier = null;
  paymentFlow.metrics = null;
  paymentFlow.packId = null;
  document.querySelector("#address-element")?.replaceChildren();
  document.querySelector("#payment-element")?.replaceChildren();
  if (dialog?.open) dialog.close();
}

async function createPaymentIntent() {
  const session = window.chargebackWorkspace?.getSession();
  if (!session?.access_token || !paymentFlow.packId || !paymentFlow.tier || !paymentFlow.metrics) {
    throw new Error("Sign in and reopen this response pack before payment.");
  }
  const { error: submitError } = await paymentFlow.elements.submit();
  if (submitError) throw new Error(submitError.message || "Check the payment details and try again.");
  const addressResult = await paymentFlow.addressElement.getValue();
  if (!addressResult.complete) throw new Error("Enter a complete billing address.");

  const response = await fetch(PAYMENT_INTENT_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tier: paymentFlow.tier.code,
      case_count: paymentFlow.metrics.caseCount,
      file_count: paymentFlow.metrics.fileCount,
      batch_id: paymentFlow.packId,
      pack_id: paymentFlow.packId,
      billing_name: addressResult.value?.name || "",
      billing_address: addressResult.value?.address || {},
    }),
    credentials: "omit",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.clientSecret || !result.paymentIntentId) {
    throw new Error(result.message || "Payment could not be prepared.");
  }
  paymentFlow.elements.update({ amount: result.amountTotal });
  paymentFlow.intent = result;
  localStorage.setItem(PAYMENT_INTENT_KEY, result.paymentIntentId);
  renderPaymentTotals(result);
  setPaymentMessage("Review the final total, then submit payment.", "success");
  const submit = document.querySelector("#submit-payment");
  if (submit) submit.textContent = `Pay ${formatPaymentAmount(result.amountTotal, result.currency)}`;
}

async function submitPayment(event) {
  event.preventDefault();
  const submit = document.querySelector("#submit-payment");
  if (!submit || submit.disabled) return;
  submit.disabled = true;
  setPaymentMessage("");
  try {
    if (!paymentFlow.intent) {
      await createPaymentIntent();
      return;
    }

    const { error: submitError } = await paymentFlow.elements.submit();
    if (submitError) throw new Error(submitError.message || "Check the payment details and try again.");
    submit.textContent = "Processing payment…";
    const returnUrl = `${window.location.origin}${window.location.pathname}?payment=return#builder`;
    const { error, paymentIntent } = await paymentFlow.stripe.confirmPayment({
      elements: paymentFlow.elements,
      clientSecret: paymentFlow.intent.clientSecret,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    if (error) throw new Error(error.message || "Stripe could not complete the payment.");
    if (!paymentIntent?.id) return;

    localStorage.setItem(PAYMENT_INTENT_KEY, paymentIntent.id);
    if (paymentIntent.status === "succeeded") {
      const entitlement = await verifyEntitlement(paymentIntent.id);
      state.entitlement = entitlement;
      await window.chargebackWorkspace?.markPackUnlocked(paymentIntent.id);
      closePaymentDialog();
      showPaymentResult("success", "Payment confirmed.", "Your clean, unmarked response pack is now unlocked in your account.");
      renderCheckoutPanel();
      return;
    }
    closePaymentDialog();
    showPaymentResult("success", "Payment submitted.", "Stripe is processing the payment. The clean pack unlocks automatically after confirmation.");
  } catch (error) {
    console.error("Chargeback Studio payment failed", error);
    setPaymentMessage(error?.message || "Payment could not be completed. Try again.");
  } finally {
    if (submit && paymentFlow.intent) {
      submit.disabled = false;
      submit.textContent = `Pay ${formatPaymentAmount(paymentFlow.intent.amountTotal, paymentFlow.intent.currency)}`;
    } else if (submit) {
      submit.disabled = false;
      submit.textContent = "Calculate total";
    }
  }
}

async function verifyEntitlement(paymentReference) {
  const session = window.chargebackWorkspace?.getSession();
  if (!session?.access_token) throw new Error("Sign in to verify this purchase.");
  const referenceParameter = String(paymentReference).startsWith("pi_")
    ? "payment_intent_id"
    : "session_id";
  const response = await fetch(`${ENTITLEMENT_ENDPOINT}?${referenceParameter}=${encodeURIComponent(paymentReference)}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${session.access_token}` },
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`Entitlement verification failed (${response.status}).`);
  const result = await response.json();
  if (!result?.unlocked) throw new Error("Payment has not been confirmed.");
  return result;
}

function showPaymentResult(kind, titleText, bodyText) {
  const status = document.querySelector("#checkout-status");
  if (!status) return;
  status.dataset.state = kind;
  status.replaceChildren();
  const title = document.createElement("strong");
  const body = document.createElement("span");
  title.textContent = titleText;
  body.textContent = bodyText;
  status.append(title, body);
  status.hidden = false;
  window.requestAnimationFrame(() => status.scrollIntoView({ block: "start" }));
}

async function showCheckoutStatus() {
  const parameters = new URLSearchParams(window.location.search);
  const checkoutState = parameters.get("checkout");
  const paymentReturn = parameters.get("payment") === "return";
  const returnedPaymentIntent = parameters.get("payment_intent");
  const sessionId = parameters.get("session_id") || localStorage.getItem(CHECKOUT_SESSION_KEY);
  const paymentIntentId = returnedPaymentIntent || localStorage.getItem(PAYMENT_INTENT_KEY);
  if (parameters.get("session_id")) localStorage.setItem(CHECKOUT_SESSION_KEY, parameters.get("session_id"));
  if (returnedPaymentIntent) localStorage.setItem(PAYMENT_INTENT_KEY, returnedPaymentIntent);
  const paymentReference = paymentIntentId || sessionId;

  if (checkoutState === "canceled") {
    showPaymentResult("canceled", "Payment canceled.", "No payment was made. Your saved cases are unchanged.");
  } else if (checkoutState === "unavailable") {
    showPaymentResult("unavailable", "Payment is temporarily unavailable.", "No payment was made. Please try again shortly.");
  } else if (checkoutState === "success" && !sessionId) {
    showPaymentResult("unavailable", "Payment could not be verified.", "Your clean pack remains locked. Contact support if you completed payment.");
  } else if (paymentReturn && !paymentIntentId) {
    showPaymentResult("unavailable", "Payment could not be verified.", "Your clean pack remains locked. Contact support if payment left your account.");
  }

  if (paymentReference) {
    if (checkoutState === "success" || paymentReturn) {
      showPaymentResult("success", "Confirming payment…", "Your clean pack unlocks after Stripe confirms the payment.");
    }
    try {
      const entitlement = await verifyEntitlement(paymentReference);
      if (entitlement.packId && entitlement.packId !== state.batchId) {
        await window.chargebackWorkspace?.openPack(entitlement.packId);
      }
      if ((entitlement.packId || entitlement.batchId) === state.batchId) {
        state.entitlement = entitlement;
        await window.chargebackWorkspace?.markPackUnlocked(paymentReference);
        if (checkoutState === "success" || paymentReturn) {
          showPaymentResult("success", "Payment confirmed.", "Your clean, unmarked response pack is now unlocked in your account.");
        }
      } else if (checkoutState === "success" || paymentReturn) {
        showPaymentResult("unavailable", "This payment belongs to another pack.", "Open the purchased pack from your account or contact support with your order reference.");
      }
    } catch (error) {
      if (checkoutState === "success" || paymentReturn) {
        showPaymentResult("unavailable", "Payment is still being confirmed.", "Your marked preview remains available. Refresh shortly; no second payment is needed.");
      }
    }
  }

  parameters.delete("checkout");
  parameters.delete("session_id");
  parameters.delete("payment");
  parameters.delete("payment_intent");
  parameters.delete("payment_intent_client_secret");
  parameters.delete("redirect_status");
  const cleanQuery = parameters.toString();
  const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", cleanUrl);
  renderCheckoutPanel();
}

function loadWorkspacePack(pack, disputes) {
  if (!pack || !Array.isArray(disputes) || !disputes.length) return;
  state.files.forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
  state.batchId = pack.id;
  state.cases = disputes.map((dispute) => {
    const reason = reasonConfig[dispute.reason_code] ? dispute.reason_code : "unrecognized";
    const allowedCategories = new Set(reasonConfig[reason].evidence.map((item) => item[0]));
    const files = (dispute.evidenceFiles || []).map((entry) => ({ ...entry }));
    return {
      id: dispute.id,
      reason,
      details: {
        ...emptyDetails(),
        merchantName: dispute.merchant_name || "",
        orderReference: dispute.order_reference || dispute.case_reference || "",
        processor: dispute.processor || "",
        amount: (Number(dispute.amount_cents || 0) / 100).toFixed(2),
        currency: dispute.currency || "USD",
        disputeDate: dispute.dispute_received_at || "",
        deadline: dispute.response_due_at || "",
        summary: dispute.summary || "",
      },
      selectedEvidence: [...new Set(files.map((entry) => entry.category).filter((category) => allowedCategories.has(category)))],
      files,
      score: Number(dispute.readiness_score || 0),
      updatedAt: dispute.updated_at || new Date().toISOString(),
    };
  });
  const current = state.cases[state.cases.length - 1];
  loadCaseIntoDraft(current);
  state.selectedTierCode = TIER_CONFIG.some((tier) => tier.code === pack.tier_code) ? pack.tier_code : null;
  const tier = getTier(pack.case_count, pack.file_count);
  state.entitlement = pack.status === "unlocked" ? {
    unlocked: true,
    batchId: pack.id,
    packId: pack.id,
    tierCode: tier?.code || pack.tier_code,
    maxCases: tier?.maxCases || pack.case_count,
    maxFiles: tier?.maxFiles || pack.file_count,
  } : null;
  void persistBatch();
  render();
  renderCheckoutPanel();
}

window.chargebackBuilder = {
  loadWorkspacePack,
  verifyCheckout: showCheckoutStatus,
};

document.querySelector("#load-demo")?.addEventListener("click", loadDemoCase);
const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

document.querySelectorAll("[data-tier-card]").forEach((card) => {
  card.addEventListener("click", () => {
    const tier = TIER_CONFIG.find((candidate) => candidate.code === card.dataset.tierCard);
    if (!tier) return;
    const metrics = getBatchMetrics();
    if (metrics.fileCount > tier.maxFiles) {
      state.selectedTierCode = null;
      renderCheckoutPanel();
      return;
    }
    state.selectedTierCode = tier.code;
    renderCheckoutPanel();
    document.querySelector("#batch-checkout-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
});

document.querySelector("#payment-form")?.addEventListener("submit", submitPayment);
document.querySelector("#cancel-payment")?.addEventListener("click", closePaymentDialog);
document.querySelector("#close-payment")?.addEventListener("click", closePaymentDialog);
document.querySelector("#payment-dialog")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePaymentDialog();
});

async function initialize() {
  await restoreBatch();
  render();
  registerWebMCP();
  await showCheckoutStatus();
}

void initialize();
})();
