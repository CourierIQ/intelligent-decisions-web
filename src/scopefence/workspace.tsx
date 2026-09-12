"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScopeFenceAccount,
  ScopeFenceHistoryItem,
  ScopeFenceSavedScope,
  ScopeFenceVerdict,
} from "./types";
import styles from "./scopefence.module.css";

type WorkspaceResponse = {
  account: ScopeFenceAccount;
  scopes: ScopeFenceSavedScope[];
  history: ScopeFenceHistoryItem[];
  user: { id: string; email: string };
};

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

type AgreementDraft = {
  clientProject: string;
  includedDeliverables: string;
  exclusions: string;
  revisionRounds: string;
  approvalMethod: string;
  schedule: string;
  paymentTerms: string;
  sourceClauses: string;
};

type RequestDraft = {
  headline: string;
  requestedWork: string;
  requestedBy: string;
  quantity: string;
  unit: string;
  contentOwner: string;
  deadlineImpact: string;
  neededBy: string;
  exactWording: string;
  signals: string[];
};

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_KEY = "0x4AAAAAADzePhY2Hgvp3XUu";
const AGREEMENT_MARKER = "[ScopeFence guided agreement]";
const REQUEST_MARKER = "[ScopeFence guided request]";

const EMPTY_AGREEMENT: AgreementDraft = {
  clientProject: "",
  includedDeliverables: "",
  exclusions: "",
  revisionRounds: "2",
  approvalMethod: "Written client approval",
  schedule: "",
  paymentTerms: "",
  sourceClauses: "",
};

const EMPTY_REQUEST: RequestDraft = {
  headline: "",
  requestedWork: "",
  requestedBy: "",
  quantity: "",
  unit: "items",
  contentOwner: "Not clear yet",
  deadlineImpact: "Keep the original delivery date",
  neededBy: "",
  exactWording: "",
  signals: [],
};

const REQUEST_SIGNALS = [
  "New deliverable",
  "Extra revisions",
  "Third-party integration",
  "Content migration",
  "Rush timing",
  "New stakeholder",
] as const;

function displayValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "Not specified.";
}

function guidedDocument(marker: string, sections: Array<[string, string]>) {
  return [marker, ...sections.map(([label, value]) => `## ${label}\n${displayValue(value)}`)].join("\n\n");
}

function agreementDocument(title: string, draft: AgreementDraft) {
  return guidedDocument(AGREEMENT_MARKER, [
    ["Agreement name", title],
    ["Client or project", draft.clientProject],
    ["Included deliverables", draft.includedDeliverables],
    ["Explicit exclusions", draft.exclusions],
    ["Revision allowance", draft.revisionRounds ? `${draft.revisionRounds} rounds` : ""],
    ["Approval method", draft.approvalMethod],
    ["Schedule and milestones", draft.schedule],
    ["Fees and payment terms", draft.paymentTerms],
    ["Source agreement clauses", draft.sourceClauses],
  ]);
}

function requestDocument(draft: RequestDraft) {
  return guidedDocument(REQUEST_MARKER, [
    ["Request headline", draft.headline],
    ["Requested work", draft.requestedWork],
    ["Requested by", draft.requestedBy],
    ["Quantity", draft.quantity ? `${draft.quantity} ${draft.unit}` : ""],
    ["Content or materials supplied by", draft.contentOwner],
    ["Scope signals", draft.signals?.join(", ") || ""],
    ["Effect on deadline", draft.deadlineImpact],
    ["Needed by", draft.neededBy],
    ["Client's exact wording", draft.exactWording],
  ]);
}

function guidedSections(content: string, marker: string) {
  if (!content.startsWith(marker)) return null;
  const sections = new Map<string, string>();
  for (const block of content.slice(marker.length).trim().split(/\n\n## /)) {
    const normalized = block.replace(/^## /, "");
    const newline = normalized.indexOf("\n");
    if (newline < 0) continue;
    const value = normalized.slice(newline + 1).trim();
    sections.set(normalized.slice(0, newline).trim(), value === "Not specified." ? "" : value);
  }
  return sections;
}

function parseAgreement(content: string, fallbackTitle: string): AgreementDraft {
  const sections = guidedSections(content, AGREEMENT_MARKER);
  if (!sections) return { ...EMPTY_AGREEMENT, clientProject: fallbackTitle, sourceClauses: content };
  return {
    clientProject: sections.get("Client or project") || "",
    includedDeliverables: sections.get("Included deliverables") || "",
    exclusions: sections.get("Explicit exclusions") || "",
    revisionRounds: (sections.get("Revision allowance") || "2").replace(/\s*rounds?$/i, ""),
    approvalMethod: sections.get("Approval method") || EMPTY_AGREEMENT.approvalMethod,
    schedule: sections.get("Schedule and milestones") || "",
    paymentTerms: sections.get("Fees and payment terms") || "",
    sourceClauses: sections.get("Source agreement clauses") || "",
  };
}

function parseRequest(content: string): RequestDraft {
  const sections = guidedSections(content, REQUEST_MARKER);
  if (!sections) return { ...EMPTY_REQUEST, headline: content.slice(0, 100), requestedWork: content };
  const signals = (sections.get("Scope signals") || "").split(", ").filter((signal) => REQUEST_SIGNALS.some((value) => value === signal));
  const quantityParts = (sections.get("Quantity") || "").match(/^(\d+)\s+(.+)$/);
  return {
    headline: sections.get("Request headline") || "",
    requestedWork: sections.get("Requested work") || "",
    requestedBy: sections.get("Requested by") || "",
    quantity: quantityParts?.[1] || "",
    unit: quantityParts?.[2] || EMPTY_REQUEST.unit,
    contentOwner: sections.get("Content or materials supplied by") || EMPTY_REQUEST.contentOwner,
    deadlineImpact: sections.get("Effect on deadline") || EMPTY_REQUEST.deadlineImpact,
    neededBy: sections.get("Needed by") || "",
    exactWording: sections.get("Client's exact wording") || "",
    signals,
  };
}

function requestHeadline(content: string) {
  return parseRequest(content).headline || "Client request";
}

function lineItems(value: string) {
  return value.split("\n");
}

function LineItemEditor(props: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  maxItems: number;
  onChange: (value: string) => void;
}) {
  const items = lineItems(props.value);

  function update(index: number, value: string) {
    const next = [...items];
    next[index] = value.replace(/[\r\n]+/g, " ");
    props.onChange(next.join("\n"));
  }

  function remove(index: number) {
    const next = items.filter((_, itemIndex) => itemIndex !== index);
    props.onChange((next.length ? next : [""]).join("\n"));
  }

  return (
    <fieldset className={styles.lineItemGroup}>
      <legend>{props.label}</legend>
      <p>{props.hint}</p>
      <div className={styles.lineItems}>
        {items.map((item, index) => (
          <div key={index}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <input
              aria-label={`${props.label} item ${index + 1}`}
              value={item}
              onChange={(event) => update(index, event.target.value)}
              maxLength={180}
              placeholder={index === 0 ? props.placeholder : "Add another item"}
            />
            {items.length > 1 ? <button type="button" onClick={() => remove(index)} aria-label={`Remove ${props.label.toLowerCase()} item ${index + 1}`}>×</button> : null}
          </div>
        ))}
      </div>
      <button type="button" className={styles.addItemButton} disabled={items.length >= props.maxItems} onClick={() => props.onChange([...items, ""].join("\n"))}>+ Add item</button>
    </fieldset>
  );
}

function turnstileApi() {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

const VERDICTS: Record<ScopeFenceVerdict, { label: string; cue: string }> = {
  included: { label: "Included", cue: "Covered by the agreement" },
  ambiguous: { label: "Ambiguous", cue: "Clarify before committing" },
  out_of_scope: { label: "Out of scope", cue: "Treat as a change" },
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function fileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "scope-change";
}

function changeOrderMarkdown(item: ScopeFenceHistoryItem) {
  const { result } = item;
  const price = result.verdict === "included"
    ? "Included in current agreement"
    : `${money(result.impact.priceMinCents)}–${money(result.impact.priceMaxCents)}`;
  const bullets = (values: string[], empty: string) => (values.length ? values : [empty]).map((value) => `- ${value}`).join("\n");
  return `# ${result.changeOrder.title}\n\n` +
    `**Prepared:** ${date(item.createdAt)}  \n` +
    `**Agreement:** ${item.scopeTitle}  \n` +
    `**Scope finding:** ${VERDICTS[result.verdict].label}  \n` +
    `**Estimated effort:** ${result.impact.hoursMin}–${result.impact.hoursMax} hours  \n` +
    `**Estimated fee:** ${price}\n\n` +
    `## Requested change\n\n${item.clientRequest}\n\n` +
    `## Change summary\n\n${result.changeOrder.summary}\n\n` +
    `## Deliverables\n\n${bullets(result.changeOrder.deliverables, "To be confirmed in writing.")}\n\n` +
    `## Exclusions\n\n${bullets(result.changeOrder.exclusions, "No additional exclusions stated.")}\n\n` +
    `## Timeline\n\n${result.changeOrder.timeline || "To be scheduled after approval."}\n\n` +
    `## Approval\n\n${result.changeOrder.approvalTerms || "Work begins after written approval of scope, timeline, and fee."}\n\n` +
    `---\n${result.disclaimer}\n`;
}

async function responseJson<T>(response: Response) {
  const body = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(body.error || "The request could not be completed.") as Error & { code?: string };
    error.code = body.code;
    throw error;
  }
  return body;
}

export function ScopeFenceWorkspace() {
  const [account, setAccount] = useState<ScopeFenceAccount | null>(null);
  const [scopes, setScopes] = useState<ScopeFenceSavedScope[]>([]);
  const [history, setHistory] = useState<ScopeFenceHistoryItem[]>([]);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [scopeTitle, setScopeTitle] = useState("Client agreement");
  const [agreementDraft, setAgreementDraft] = useState<AgreementDraft>(EMPTY_AGREEMENT);
  const [requestDraft, setRequestDraft] = useState<RequestDraft>(EMPTY_REQUEST);
  const [hourlyRate, setHourlyRate] = useState("125");
  const [active, setActive] = useState<ScopeFenceHistoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const localPreview = false;
  const [busy, setBusy] = useState<"" | "auth" | "save" | "analyze" | "payment">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const turnstileNode = useRef<HTMLDivElement>(null);
  const turnstileId = useRef("");
  const turnstileToken = useRef("");
  const analysisRequestId = useRef("");
  const scopeText = useMemo(() => agreementDocument(scopeTitle, agreementDraft), [agreementDraft, scopeTitle]);
  const clientRequest = useMemo(() => requestDocument(requestDraft), [requestDraft]);

  function updateAgreement<K extends keyof AgreementDraft>(field: K, value: AgreementDraft[K]) {
    setAgreementDraft((current) => ({ ...current, [field]: value }));
    setScopeId(null);
  }

  function updateRequest<K extends keyof RequestDraft>(field: K, value: RequestDraft[K]) {
    setRequestDraft((current) => ({ ...current, [field]: value }));
  }

  function toggleRequestSignal(signal: string) {
    setRequestDraft((current) => ({
      ...current,
      signals: current.signals.includes(signal)
        ? current.signals.filter((value) => value !== signal)
        : [...current.signals, signal],
    }));
  }

  const loadWorkspace = useCallback(async () => {
    let response = await fetch("/api/scopefence/workspace", { cache: "no-store" });
    if (response.status === 401) {
      const refreshed = await fetch("/api/scopefence/auth/refresh", { method: "POST" });
      if (refreshed.ok) response = await fetch("/api/scopefence/workspace", { cache: "no-store" });
    }
    if (response.status === 401) {
      setAccount(null);
      setScopes([]);
      setHistory([]);
      return;
    }
    const body = await responseJson<WorkspaceResponse>(response);
    setAccount(body.account);
    setEmail(body.user.email);
    setScopes(body.scopes);
    setHistory(body.history);
  }, []);

  useEffect(() => {
    let live = true;
    const frame = window.requestAnimationFrame(() => {
      loadWorkspace().catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : "Your workspace could not be loaded.");
      }).finally(() => { if (live) setLoading(false); });
      const params = new URLSearchParams(window.location.search);
      if (params.get("payment") === "return") {
        setMessage("Payment received. Credits appear as soon as Stripe confirms it.");
        window.history.replaceState({}, "", "/projects/scopefence/");
      }
    });
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (localPreview !== false || loading || account || codeSent || !turnstileNode.current) return;
    let cancelled = false;
    function render() {
      const api = turnstileApi();
      if (!api || !turnstileNode.current || cancelled || turnstileId.current) return;
      turnstileId.current = api.render(turnstileNode.current, {
        sitekey: TURNSTILE_KEY,
        action: "scopefence_account",
        theme: "dark",
        size: "flexible",
        callback: (token: string) => {
          turnstileToken.current = token;
          setError("");
        },
        "expired-callback": () => { turnstileToken.current = ""; },
        "error-callback": () => {
          turnstileToken.current = "";
          setError("The security check could not be completed.");
          return true;
        },
      });
    }
    if (turnstileApi()) render();
    else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      cancelled = true;
      if (turnstileId.current) turnstileApi()?.remove(turnstileId.current);
      turnstileId.current = "";
      turnstileToken.current = "";
    };
  }, [account, codeSent, loading]);

  const usage = useMemo(() => {
    if (!account) return "3 free analyses";
    if (account.freeAnalysesRemaining) return `${account.freeAnalysesRemaining} free ${account.freeAnalysesRemaining === 1 ? "analysis" : "analyses"} left`;
    return `${account.paidCreditBalance} paid ${account.paidCreditBalance === 1 ? "credit" : "credits"}`;
  }, [account]);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!localPreview && !turnstileToken.current) {
      setError("Complete the security check first.");
      return;
    }
    setBusy("auth");
    try {
      const form = new FormData(event.currentTarget);
      await responseJson(await fetch("/api/scopefence/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          website: form.get("website"),
          turnstileToken: turnstileToken.current,
        }),
      }));
      setCodeSent(true);
      setMessage("A six-digit sign-in code is on its way.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A code could not be sent.");
      turnstileToken.current = "";
      turnstileApi()?.reset(turnstileId.current);
    } finally {
      setBusy("");
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy("auth");
    try {
      const form = new FormData(event.currentTarget);
      await responseJson(await fetch("/api/scopefence/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: form.get("code") }),
      }));
      await loadWorkspace();
      setCodeSent(false);
      setMessage("You are signed in. Your workspace is ready.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That code could not be verified.");
    } finally {
      setBusy("");
    }
  }

  async function signOut() {
    setBusy("auth");
    setError("");
    try {
      await responseJson(await fetch("/api/scopefence/auth/logout", { method: "POST" }));
      setAccount(null);
      setScopes([]);
      setHistory([]);
      setActive(null);
      setEmail("");
      setCodeSent(false);
      setMessage("You are signed out. Your current draft remains on this device until you leave the page.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "You could not be signed out.");
    } finally {
      setBusy("");
    }
  }

  function chooseScope(id: string) {
    const selected = scopes.find((scope) => scope.id === id);
    if (!selected) {
      setScopeId(null);
      return;
    }
    setScopeId(selected.id);
    setScopeTitle(selected.title);
    setAgreementDraft(parseAgreement(selected.content, selected.title));
    setMessage(`Loaded “${selected.title}.”`);
    setError("");
  }

  async function saveScope() {
    setError("");
    setMessage("");
    if (!account) {
      setError("Sign in to save agreements to your workspace.");
      return;
    }
    const agreementDetail = `${agreementDraft.includedDeliverables} ${agreementDraft.sourceClauses}`.trim();
    if (!scopeTitle.trim() || !agreementDraft.clientProject.trim() || agreementDetail.length < 20) {
      setError("Add an agreement name, client or project, and the included work before saving.");
      return;
    }
    setBusy("save");
    try {
      const body = await responseJson<{ scope: ScopeFenceSavedScope }>(await fetch("/api/scopefence/scopes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: scopeTitle, content: scopeText }),
      }));
      setScopes((current) => [body.scope, ...current]);
      setScopeId(body.scope.id);
      setMessage("Agreement saved. You can reuse it on the next request.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The agreement could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function analyze() {
    setError("");
    setMessage("");
    if (!account) {
      setError("Sign in to run the analysis and keep its history private.");
      return;
    }
    const agreementDetail = `${agreementDraft.includedDeliverables} ${agreementDraft.sourceClauses}`.trim();
    if (!scopeTitle.trim() || !agreementDraft.clientProject.trim() || agreementDetail.length < 20) {
      setError("Complete the agreement name, client or project, and included work first.");
      return;
    }
    if (requestDraft.headline.trim().length < 5 || requestDraft.requestedWork.trim().length < 20) {
      setError("Add a short request headline and describe what needs to change.");
      return;
    }
    const rate = Number(hourlyRate);
    if (!Number.isFinite(rate) || rate < 25 || rate > 1000) {
      setError("Use an hourly rate between $25 and $1,000.");
      return;
    }
    setBusy("analyze");
    try {
      if (!analysisRequestId.current) analysisRequestId.current = crypto.randomUUID();
      const body = await responseJson<{ analysis: ScopeFenceHistoryItem; account: ScopeFenceAccount }>(await fetch("/api/scopefence/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: analysisRequestId.current, scopeId, scopeTitle, scopeText, clientRequest, hourlyRate: rate }),
      }));
      analysisRequestId.current = "";
      setActive(body.analysis);
      setAccount(body.account);
      setHistory((current) => [body.analysis, ...current]);
      setMessage("Analysis complete. Review the evidence before sending anything to your client.");
      window.setTimeout(() => document.getElementById("scopefence-result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (reason) {
      const typed = reason as Error & { code?: string };
      setError(typed.message || "The analysis could not be completed.");
      if (typed.code === "credit_required") void openCheckout();
    } finally {
      setBusy("");
    }
  }

  async function openCheckout() {
    if (!account || busy === "payment") return;
    setBusy("payment");
    setError("");
    try {
      const body = await responseJson<{ checkoutUrl: string }>(await fetch("/api/scopefence/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      }));
      window.location.assign(body.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Payments are not available right now.");
    } finally {
      setBusy("");
    }
  }

  function openHistory(item: ScopeFenceHistoryItem) {
    setActive(item);
    setScopeId(item.scopeId);
    setScopeTitle(item.scopeTitle);
    setAgreementDraft(parseAgreement(item.scopeText, item.scopeTitle));
    setRequestDraft(parseRequest(item.clientRequest));
    setHourlyRate(String(item.hourlyRateCents / 100));
    setError("");
    setMessage(`Opened analysis from ${date(item.createdAt)}.`);
    window.setTimeout(() => document.getElementById("scopefence-result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function copyResponse() {
    if (!active) return;
    await navigator.clipboard.writeText(`Subject: ${active.result.clientResponse.subject}\n\n${active.result.clientResponse.body}`);
    setMessage("Client response copied.");
  }

  function downloadChangeOrder() {
    if (!active) return;
    const blob = new Blob([changeOrderMarkdown(active)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileName(active.scopeTitle)}-change-order.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Change order downloaded.");
  }

  return (
    <div className={styles.product} id="scopefence-workspace">
      <section className={styles.intro} aria-labelledby="scopefence-title">
        <div>
          <p className={styles.eyebrow}>Scope control for client work</p>
          <h1 id="scopefence-title">Turn “one more thing” into a clear decision.</h1>
        </div>
        <p>Compare a new request to the agreement, price the likely impact, and leave with language you can send—not a confrontation you have to improvise.</p>
      </section>

      {!loading && !account ? (
        <section className={styles.signInNotice} aria-label="Sign in required">
          <div><span>Private by default</span><strong>Your first three analyses are free.</strong><p>Use a one-time email code. No password, and your agreements stay attached to your account.</p></div>
          <form className={styles.authForm} onSubmit={codeSent ? verifyCode : requestCode}>
            <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" disabled={codeSent || busy === "auth"} required /></label>
            <label className={styles.honeypot} aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
            {codeSent ? <label>Six-digit code<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></label> : <div ref={turnstileNode} className={styles.turnstile} />}
            <button type="submit" disabled={busy === "auth"}>{busy === "auth" ? "Please wait…" : codeSent ? "Verify and continue" : "Email me a code"}</button>
            {codeSent ? <button type="button" className={styles.authBack} onClick={() => { setCodeSent(false); setError(""); }}>Use another email</button> : null}
          </form>
        </section>
      ) : null}

      <section className={styles.usageBar} aria-label="Analysis allowance">
        <div><span className={styles.pulse} aria-hidden="true" /><strong>{loading ? "Loading allowance…" : usage}</strong><small>{account ? account.email : "Sign in to begin"}</small></div>
        {account ? <div className={styles.usageActions}><button type="button" onClick={openCheckout} disabled={busy === "payment"}>{busy === "payment" ? "Opening…" : "Add 20 credits · $29"}</button><button type="button" className={styles.signOutButton} onClick={signOut} disabled={busy === "auth"}>Sign out</button></div> : null}
      </section>

      <div className={styles.workbench}>
        <section className={styles.composer} aria-label="Scope analysis inputs">
          <div className={styles.stepHeading}><span>01</span><div><h2>Define the baseline</h2><p>Capture the exact boundaries that decide whether new work belongs.</p></div></div>
          {account && scopes.length ? (
            <label className={styles.fieldLabel}>Saved agreements
              <select value={scopeId || ""} onChange={(event) => chooseScope(event.target.value)}>
                <option value="">New guided agreement</option>
                {scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.title}</option>)}
              </select>
            </label>
          ) : null}
          <div className={styles.fieldGrid}>
            <label className={styles.fieldLabel}>Agreement name
              <input value={scopeTitle} onChange={(event) => { setScopeTitle(event.target.value); setScopeId(null); }} maxLength={80} placeholder="Website redesign · May 2026" />
            </label>
            <label className={styles.fieldLabel}>Client or project
              <input value={agreementDraft.clientProject} onChange={(event) => updateAgreement("clientProject", event.target.value)} maxLength={100} placeholder="Northstar Coffee website" />
            </label>
          </div>

          <div className={styles.guidedCard}>
            <div className={styles.cardHeading}><span>Scope baseline</span><p>Use the language both sides agreed to. Short bullet points work best.</p></div>
            <LineItemEditor
              label="Included deliverables"
              hint="Add each promised outcome as its own item."
              value={agreementDraft.includedDeliverables}
              placeholder="Five-page marketing website"
              maxItems={8}
              onChange={(value) => updateAgreement("includedDeliverables", value)}
            />
            <LineItemEditor
              label="Explicit exclusions"
              hint="Add each boundary the agreement states."
              value={agreementDraft.exclusions}
              placeholder="Copywriting and photography"
              maxItems={6}
              onChange={(value) => updateAgreement("exclusions", value)}
            />

            <div className={styles.boundaryGrid}>
              <label className={styles.fieldLabel}>Revision rounds
                <input type="number" min="0" max="12" step="1" value={agreementDraft.revisionRounds} onChange={(event) => updateAgreement("revisionRounds", event.target.value)} />
              </label>
              <label className={styles.fieldLabel}>Approval required through
                <select value={agreementDraft.approvalMethod} onChange={(event) => updateAgreement("approvalMethod", event.target.value)}>
                  <option>Written client approval</option>
                  <option>Signed change order</option>
                  <option>Named stakeholder approval</option>
                  <option>Not specified</option>
                </select>
              </label>
            </div>

            <div className={styles.fieldGrid}>
              <label className={styles.fieldLabel}>Schedule and milestones
                <input value={agreementDraft.schedule} onChange={(event) => updateAgreement("schedule", event.target.value)} maxLength={240} placeholder="Design approval June 12 · launch June 30" />
              </label>
              <label className={styles.fieldLabel}>Fees and payment terms
                <input value={agreementDraft.paymentTerms} onChange={(event) => updateAgreement("paymentTerms", event.target.value)} maxLength={240} placeholder="$6,000 fixed · 50% deposit · balance at launch" />
              </label>
            </div>

            <details className={styles.sourceDetails}>
              <summary><span>Add key contract wording</span><small>Optional · 4,000 characters</small></summary>
              <label className={styles.fieldLabel}>Relevant clauses from the signed agreement
                <textarea value={agreementDraft.sourceClauses} onChange={(event) => updateAgreement("sourceClauses", event.target.value)} maxLength={4_000} rows={5} placeholder="Paste only the clauses that define deliverables, exclusions, revisions, schedule, fees, or change approval." />
              </label>
            </details>
          </div>
          <button className={styles.textButton} type="button" onClick={saveScope} disabled={busy === "save" || !account}>{busy === "save" ? "Saving…" : "Save this agreement"}</button>

          <div className={styles.rule} />
          <div className={styles.stepHeading}><span>02</span><div><h2>Describe what changed</h2><p>Separate the actual request from the pressure around it.</p></div></div>
          <div className={styles.fieldGrid}>
            <label className={styles.fieldLabel}>Request headline
              <input value={requestDraft.headline} onChange={(event) => updateRequest("headline", event.target.value)} maxLength={100} placeholder="Add a gated resource library" />
            </label>
            <label className={styles.fieldLabel}>Requested by
              <input value={requestDraft.requestedBy} onChange={(event) => updateRequest("requestedBy", event.target.value)} maxLength={80} placeholder="Maya · Marketing lead" />
            </label>
          </div>
          <LineItemEditor
            label="Requested additions or changes"
            hint="Break the request into concrete pieces instead of one description."
            value={requestDraft.requestedWork}
            placeholder="Build a password-protected resources area"
            maxItems={8}
            onChange={(value) => updateRequest("requestedWork", value)}
          />

          <div className={styles.requestFacts}>
            <label className={styles.fieldLabel}>Quantity
              <input type="number" min="1" max="10000" step="1" value={requestDraft.quantity || ""} onChange={(event) => updateRequest("quantity", event.target.value)} placeholder="60" />
            </label>
            <label className={styles.fieldLabel}>Unit
              <select value={requestDraft.unit || EMPTY_REQUEST.unit} onChange={(event) => updateRequest("unit", event.target.value)}>
                <option>items</option>
                <option>pages</option>
                <option>screens</option>
                <option>files</option>
                <option>products</option>
                <option>records</option>
                <option>hours</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>Content or materials supplied by
              <select value={requestDraft.contentOwner || EMPTY_REQUEST.contentOwner} onChange={(event) => updateRequest("contentOwner", event.target.value)}>
                <option>Not clear yet</option>
                <option>Client, ready to use</option>
                <option>Client, needs cleanup</option>
                <option>My team</option>
                <option>Shared responsibility</option>
              </select>
            </label>
          </div>

          <fieldset className={styles.signalGroup}>
            <legend>What kind of scope pressure is this?</legend>
            <div className={styles.signalGrid}>{REQUEST_SIGNALS.map((signal) => (
              <label className={styles.signalOption} key={signal}>
                <input type="checkbox" checked={requestDraft.signals.includes(signal)} onChange={() => toggleRequestSignal(signal)} />
                <span>{signal}</span>
              </label>
            ))}</div>
          </fieldset>

          <div className={styles.fieldGrid}>
            <label className={styles.fieldLabel}>Deadline expectation
              <select value={requestDraft.deadlineImpact} onChange={(event) => updateRequest("deadlineImpact", event.target.value)}>
                <option>Keep the original delivery date</option>
                <option>Move the delivery date earlier</option>
                <option>A new date is acceptable</option>
                <option>No deadline was discussed</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>Needed by
              <input type="date" value={requestDraft.neededBy} onChange={(event) => updateRequest("neededBy", event.target.value)} />
            </label>
          </div>

          <details className={styles.sourceDetails}>
            <summary><span>Add the client’s exact wording</span><small>Optional · 1,200 characters</small></summary>
            <label className={styles.fieldLabel}>Email, chat, or meeting quote
              <textarea value={requestDraft.exactWording} onChange={(event) => updateRequest("exactWording", event.target.value)} maxLength={1_200} rows={3} placeholder="Could you also add this before launch? It should be quick since the PDFs already exist." />
            </label>
          </details>
          <label className={`${styles.fieldLabel} ${styles.rateField}`}>Your hourly rate
            <span><b aria-hidden="true">$</b><input inputMode="decimal" type="number" min="25" max="1000" step="5" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} /><i>/ hour</i></span>
          </label>
          <button className={styles.analyzeButton} type="button" onClick={analyze} disabled={busy === "analyze" || !account}>
            <span>{busy === "analyze" ? "Reading the agreement…" : "Check this request"}</span><b aria-hidden="true">→</b>
          </button>
          {!account ? <p className={styles.mobileSignIn}>Sign in above to analyze this request.</p> : null}
          {error ? <p className={styles.formError} role="alert">{error}</p> : null}
          {message ? <p className={styles.formMessage} role="status">{message}</p> : null}
        </section>

        <aside className={styles.history} aria-labelledby="history-title">
          <div><p className={styles.eyebrow}>Workspace record</p><h2 id="history-title">Recent checks</h2></div>
          {loading ? <p className={styles.emptyHistory}>Loading your history…</p> : history.length ? (
            <ol>{history.map((item) => (
              <li key={item.id}><button type="button" onClick={() => openHistory(item)}>
                <span className={styles[`mini_${item.result.verdict}`]}>{VERDICTS[item.result.verdict].label}</span>
                <strong>{item.scopeTitle}</strong>
                <p>{requestHeadline(item.clientRequest)}</p>
                <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
              </button></li>
            ))}</ol>
          ) : <p className={styles.emptyHistory}>{account ? "Your completed checks will appear here." : "Sign in to keep a private, reusable history."}</p>}
        </aside>
      </div>

      {active ? (
        <section className={styles.result} id="scopefence-result" aria-labelledby="result-title">
          <div className={`${styles.verdict} ${styles[`verdict_${active.result.verdict}`]}`}>
            <div><p>Scope verdict</p><h2 id="result-title">{VERDICTS[active.result.verdict].label}</h2><span>{VERDICTS[active.result.verdict].cue} · {active.result.confidence} confidence</span></div>
            <p>{active.result.summary}</p>
          </div>
          <div className={styles.resultGrid}>
            <article className={styles.evidenceCard}>
              <header><span>Evidence</span><h3>What the agreement says</h3></header>
              {active.result.evidence.length ? <ol>{active.result.evidence.map((item, index) => (
                <li key={`${item.quote}-${index}`}><blockquote>“{item.quote}”</blockquote><p>{item.explanation}</p></li>
              ))}</ol> : <div className={styles.noEvidence}><strong>No decisive clause found.</strong><p>The absence of explicit language is why this result is ambiguous. Clarify it in writing before starting.</p></div>}
            </article>
            <article className={styles.impactCard}>
              <header><span>Likely impact</span><h3>Time and price</h3></header>
              <div className={styles.impactNumbers}><p><strong>{active.result.impact.hoursMin}–{active.result.impact.hoursMax}</strong><span>hours</span></p><p><strong>{money(active.result.impact.priceMinCents)}–{money(active.result.impact.priceMaxCents)}</strong><span>at ${active.hourlyRateCents / 100}/hr</span></p></div>
              <p>{active.result.impact.rationale}</p>
              {active.result.assumptions.length ? <details><summary>Assumptions</summary><ul>{active.result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details> : null}
            </article>
            <article className={styles.responseCard}>
              <header><span>Client-ready response</span><h3>{active.result.clientResponse.subject}</h3></header>
              <div className={styles.responseBody}>{active.result.clientResponse.body.split("\n").map((line, index) => <p key={`${line}-${index}`}>{line || "\u00a0"}</p>)}</div>
              <button className={styles.secondaryButton} type="button" onClick={copyResponse}>Copy response</button>
            </article>
            <article className={styles.changeOrderCard}>
              <header><span>Change order</span><h3>{active.result.changeOrder.title}</h3></header>
              <p>{active.result.changeOrder.summary}</p>
              <dl><div><dt>Timeline</dt><dd>{active.result.changeOrder.timeline || "Confirm after approval"}</dd></div><div><dt>Fee range</dt><dd>{active.result.verdict === "included" ? "Included" : `${money(active.result.impact.priceMinCents)}–${money(active.result.impact.priceMaxCents)}`}</dd></div></dl>
              <button className={styles.downloadButton} type="button" onClick={downloadChangeOrder}>Download .md <span aria-hidden="true">↓</span></button>
            </article>
          </div>
          <p className={styles.disclaimer}>{active.result.disclaimer}</p>
        </section>
      ) : (
        <section className={styles.emptyResult} aria-label="Analysis result preview">
          <span>03</span><div><h2>A boundary you can explain.</h2><p>Your evidence, estimate, reply, and change order will appear here after analysis.</p></div>
          <div aria-hidden="true"><i /><i /><i /></div>
        </section>
      )}

    </div>
  );
}
