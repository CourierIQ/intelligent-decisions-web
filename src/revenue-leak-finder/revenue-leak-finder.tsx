"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ColumnMapping,
  createReportCsv,
  CsvTable,
  formatMoney,
  inferMapping,
  LeakCategory,
  MAX_FILE_BYTES,
  parseCsv,
  reconcile,
  ReconciliationResult,
  SemanticField,
  validateMapping,
} from "./reconciliation";
import { SAMPLE_LEDGER_CSV, SAMPLE_REVENUE_CSV } from "./sample-data";
import styles from "./revenue-leak-finder.module.css";

type SourceFile = { name: string; table: CsvTable };
type Account = { email: string; reportCredits: number; freeReportsRemaining: number; reportsCompleted: number };
type HistoryItem = {
  id: string;
  leftName: string;
  rightName: string;
  leftRows: number;
  rightRows: number;
  issueCount: number;
  valueAtRiskCents: number;
  summary?: {
    currencies?: string[];
    valueAtRiskByCurrency?: Record<string, number>;
  };
  createdAt: string;
};
type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_KEY = "0x4AAAAAADzePhY2Hgvp3XUu";

const FIELDS: Array<{ key: SemanticField; label: string; detail: string; required?: boolean }> = [
  { key: "transactionId", label: "Transaction ID", detail: "Processor payment or charge ID" },
  { key: "invoiceId", label: "Invoice / order ID", detail: "Shared invoice or order reference" },
  { key: "customerId", label: "Customer ID", detail: "Stable account identifier" },
  { key: "email", label: "Customer email", detail: "Fallback customer match" },
  { key: "amount", label: "Amount", detail: "Gross paid or recorded amount", required: true },
  { key: "currency", label: "Currency", detail: "ISO code such as USD" },
  { key: "status", label: "Payment status", detail: "Paid, failed, refunded, void…" },
  { key: "subscriptionStatus", label: "Subscription status", detail: "Active, past due, canceled…" },
  { key: "date", label: "Date", detail: "Used to select the closest match" },
];

const CATEGORY_LABELS: Record<LeakCategory, string> = {
  missing_payment: "Missing payment record",
  missing_record: "Unverified ledger payment",
  amount_mismatch: "Amount mismatch",
  currency_mismatch: "Currency mismatch",
  status_mismatch: "Payment status mismatch",
  subscription_mismatch: "Subscription mismatch",
  duplicate: "Possible duplicate",
  unmatched_customer: "Unmatched customer",
  total_mismatch: "Total mismatch",
};

function turnstileApi() {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

async function responseJson<T>(response: Response) {
  const body = await response.json() as T & { error?: string; account?: Account };
  if (!response.ok) {
    const error = new Error(body.error || "The request could not be completed.") as Error & { status?: number; account?: Account };
    error.status = response.status;
    error.account = body.account;
    throw error;
  }
  return body;
}

function safeFileName(name: string) {
  return name.replace(/\.csv$/i, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "reconciliation";
}

function summaryPayload(result: ReconciliationResult) {
  return {
    matchedCount: result.matchedCount,
    leftTotalCents: result.leftTotalCents,
    rightTotalCents: result.rightTotalCents,
    sourceRowCoverage: result.sourceRowCoverage,
    currencies: result.currencies,
    leftTotalsByCurrency: result.leftTotalsByCurrency,
    rightTotalsByCurrency: result.rightTotalsByCurrency,
    valueAtRiskByCurrency: result.valueAtRiskByCurrency,
    issueCounts: result.issueCounts,
  };
}

function moneyBreakdown(totals: Record<string, number>) {
  return Object.entries(totals)
    .filter(([, cents]) => cents !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => formatMoney(cents, currency))
    .join(" · ") || "No paid value";
}

function sourceLabel(source: "left" | "right" | "both") {
  if (source === "left") return "Revenue source";
  if (source === "right") return "Ledger / CRM";
  return "Both files";
}

function FileDrop({
  id,
  eyebrow,
  title,
  source,
  onFile,
}: {
  id: string;
  eyebrow: string;
  title: string;
  source: SourceFile | null;
  onFile: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  function change(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = "";
  }
  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }
  return (
    <label
      className={`${styles.dropzone} ${source ? styles.dropzoneReady : ""} ${dragging ? styles.dropzoneDragging : ""}`}
      htmlFor={id}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <input id={id} type="file" accept=".csv,text/csv" onChange={change} />
      <span className={styles.dropEyebrow}>{source ? "Ready to map" : eyebrow}</span>
      <strong>{source ? source.name : title}</strong>
      <small>{source ? `${source.table.rows.length.toLocaleString()} rows · ${source.table.headers.length} columns` : "Drop a CSV or choose a file · 5 MB max"}</small>
      <i aria-hidden="true">{source ? "✓" : "+"}</i>
    </label>
  );
}

export function RevenueLeakFinder() {
  const [left, setLeft] = useState<SourceFile | null>(null);
  const [right, setRight] = useState<SourceFile | null>(null);
  const [leftMap, setLeftMap] = useState<ColumnMapping>({});
  const [rightMap, setRightMap] = useState<ColumnMapping>({});
  const [stage, setStage] = useState<"upload" | "map" | "results">("upload");
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [analysisKey, setAnalysisKey] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [demo, setDemo] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [accountChecked, setAccountChecked] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<"all" | "high" | "medium" | "low">("all");
  const [category, setCategory] = useState<"all" | LeakCategory>("all");
  const [query, setQuery] = useState("");
  const turnstileNode = useRef<HTMLDivElement>(null);
  const turnstileId = useRef("");
  const turnstileToken = useRef("");
  const checkoutPoll = useRef(0);

  async function loadAccount() {
    const first = await fetch("/api/revenue-leak-finder/account", { cache: "no-store" });
    if (first.ok) {
      const data = await responseJson<{ account: Account; history: HistoryItem[] }>(first);
      setAccount(data.account);
      setHistory(data.history);
      return data.account;
    }
    if (first.status !== 401) return null;
    const refreshed = await fetch("/api/revenue-leak-finder/auth/refresh", { method: "POST" });
    if (!refreshed.ok) return null;
    const data = await responseJson<{ account: Account }>(refreshed);
    setAccount(data.account);
    const accountResponse = await fetch("/api/revenue-leak-finder/account", { cache: "no-store" });
    if (accountResponse.ok) {
      const loaded = await responseJson<{ account: Account; history: HistoryItem[] }>(accountResponse);
      setAccount(loaded.account);
      setHistory(loaded.history);
      return loaded.account;
    }
    return data.account;
  }

  useEffect(() => {
    const purchase = new URLSearchParams(window.location.search).get("purchase");
    let refreshTimer = 0;
    const initialTimer = window.setTimeout(() => {
      void loadAccount().catch(() => undefined).finally(() => setAccountChecked(true));
      if (purchase) {
        setMessage(purchase === "success" ? "Payment received. Credits appear after Stripe confirms the purchase." : "Checkout canceled. Your account was not charged.");
        window.history.replaceState({}, "", "/projects/revenue-leak-finder/");
        if (purchase === "success") {
          refreshTimer = window.setTimeout(() => loadAccount().catch(() => undefined), 2500);
        }
      }
    }, 0);
    return () => { window.clearTimeout(initialTimer); window.clearTimeout(refreshTimer); };
  }, []);

  useEffect(() => () => window.clearInterval(checkoutPoll.current), []);

  useEffect(() => {
    if (!authOpen || account || codeSent || !turnstileNode.current) return;
    let cancelled = false;
    const render = () => {
      const api = turnstileApi();
      if (!api || cancelled || !turnstileNode.current || turnstileId.current) return;
      turnstileId.current = api.render(turnstileNode.current, {
        sitekey: TURNSTILE_KEY,
        action: "revenue_leak_account",
        theme: "dark",
        size: "flexible",
        callback: (token: string) => { turnstileToken.current = token; setError(""); },
        "expired-callback": () => { turnstileToken.current = ""; },
        "error-callback": () => { turnstileToken.current = ""; setError("The security check could not be completed."); return true; },
      });
    };
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
  }, [account, authOpen, codeSent]);

  async function readFile(file: File, side: "left" | "right") {
    setError("");
    setMessage("");
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Choose a CSV file for each source."); return; }
    if (file.size > MAX_FILE_BYTES) { setError("Each CSV must be 5 MB or smaller."); return; }
    try {
      const table = parseCsv(await file.text());
      const source = { name: file.name, table };
      if (side === "left") { setLeft(source); setLeftMap(inferMapping(table.headers)); }
      else { setRight(source); setRightMap(inferMapping(table.headers)); }
      setResult(null);
      setAuthorized(false);
      setDemo(false);
      const counterpart = side === "left" ? right : left;
      if (counterpart) setStage("map");
    } catch (reason) {
      setError(reason instanceof Error ? `${file.name}: ${reason.message}` : `${file.name} could not be read.`);
    }
  }

  function loadDemo() {
    const demoLeft = { name: "stripe-payments-demo.csv", table: parseCsv(SAMPLE_REVENUE_CSV) };
    const demoRight = { name: "ledger-demo.csv", table: parseCsv(SAMPLE_LEDGER_CSV) };
    const inferredLeft = inferMapping(demoLeft.table.headers);
    const inferredRight = inferMapping(demoRight.table.headers);
    setLeft(demoLeft);
    setRight(demoRight);
    setLeftMap(inferredLeft);
    setRightMap(inferredRight);
    setDemo(true);
    setResult(reconcile(demoLeft.table, demoRight.table, inferredLeft, inferredRight));
    setAuthorized(true);
    setAnalysisKey(`demo-${Date.now()}`);
    setStage("results");
    setError("");
    setMessage("Demo loaded. These sample mismatches are safe to explore and export.");
  }

  function runAnalysis() {
    setError("");
    setMessage("");
    if (!left || !right) { setError("Add both CSV exports first."); return; }
    const mappingErrors = validateMapping(leftMap, rightMap);
    if (mappingErrors.length) { setError(mappingErrors.join(" ")); return; }
    try {
      const nextResult = reconcile(left.table, right.table, leftMap, rightMap);
      const nextAnalysisKey = crypto.randomUUID();
      setResult(nextResult);
      setAnalysisKey(nextAnalysisKey);
      setAuthorized(false);
      setDemo(false);
      setStage("results");
      if (account) void authorizeAnalysis(nextResult, nextAnalysisKey);
      else setAuthOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The files could not be reconciled.");
    }
  }

  async function authorizeAnalysis(nextResult = result, key = analysisKey) {
    if (!nextResult || !left || !right) return;
    const stableKey = key || crypto.randomUUID();
    if (!key) setAnalysisKey(stableKey);
    setBusy(true);
    setError("");
    try {
      const data = await responseJson<{ account: Account; used: string }>(await fetch("/api/revenue-leak-finder/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisKey: stableKey,
          leftName: left.name,
          rightName: right.name,
          leftRows: nextResult.leftCount,
          rightRows: nextResult.rightCount,
          issueCount: nextResult.issues.length,
          valueAtRiskCents: nextResult.valueAtRiskCents,
          summary: summaryPayload(nextResult),
        }),
      }));
      setAccount(data.account);
      setAuthorized(true);
      setAuthOpen(false);
      setMessage(data.used === "free" ? "Your first full report is unlocked." : "Report unlocked with one credit.");
      void loadAccount();
    } catch (reason) {
      const typed = reason as Error & { status?: number; account?: Account };
      if (typed.account) setAccount(typed.account);
      if (typed.status === 401) setAuthOpen(true);
      setError(typed.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!turnstileToken.current) { setError("Complete the security check first."); return; }
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await responseJson(await fetch("/api/revenue-leak-finder/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken: turnstileToken.current, website: form.get("website") }),
      }));
      setCodeSent(true);
      setMessage("A six-digit sign-in code is on its way.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A sign-in code could not be sent.");
      turnstileToken.current = "";
      turnstileApi()?.reset(turnstileId.current);
    } finally { setBusy(false); }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await responseJson<{ account: Account }>(await fetch("/api/revenue-leak-finder/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: new FormData(event.currentTarget).get("code") }),
      }));
      setAccount(data.account);
      setCodeSent(false);
      setMessage("Signed in. Your reports can now be saved to history.");
      if (result && !authorized) await authorizeAnalysis(result, analysisKey);
      else setAuthOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That code could not be verified.");
    } finally { setBusy(false); }
  }

  async function buyCredits() {
    const checkoutWindow = window.open("about:blank", "idiRevenueLeakCheckout");
    setBusy(true);
    setError("");
    try {
      const data = await responseJson<{ url: string }>(await fetch("/api/revenue-leak-finder/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      }));
      if (!checkoutWindow) {
        throw new Error("Allow pop-ups for this site so Stripe Checkout can open without losing your report.");
      }
      checkoutWindow.opener = null;
      checkoutWindow.location.assign(data.url);
      setMessage("Stripe Checkout opened in a new window. This report will stay here while payment is confirmed.");
      window.clearInterval(checkoutPoll.current);
      let attempts = 0;
      checkoutPoll.current = window.setInterval(() => {
        attempts += 1;
        void loadAccount().then((nextAccount) => {
          if (nextAccount && nextAccount.reportCredits > (account?.reportCredits || 0)) {
            window.clearInterval(checkoutPoll.current);
            setMessage("Payment confirmed. Your new report credits are ready.");
          } else if (attempts >= 30) {
            window.clearInterval(checkoutPoll.current);
          }
        }).catch(() => undefined);
      }, 2000);
      setBusy(false);
    } catch (reason) {
      checkoutWindow?.close();
      setError(reason instanceof Error ? reason.message : "Checkout could not be started.");
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/revenue-leak-finder/auth/logout", { method: "POST" });
    setAccount(null);
    setHistory([]);
    setAuthorized(demo);
    setMessage("Signed out. Your local files are unchanged.");
  }

  function downloadReport() {
    if (!result || !authorized) return;
    const blob = new Blob([createReportCsv(result)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(left?.name || "revenue")}-reconciliation-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetWorkspace() {
    setLeft(null); setRight(null); setLeftMap({}); setRightMap({}); setResult(null);
    setStage("upload"); setAuthorized(false); setDemo(false); setError(""); setMessage("");
  }

  const filteredIssues = useMemo(() => (result?.issues || []).filter((issue) => {
    const matchesSeverity = severity === "all" || issue.severity === severity;
    const matchesCategory = category === "all" || issue.category === category;
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || `${issue.reference} ${issue.customer} ${issue.reason}`.toLowerCase().includes(needle);
    return matchesSeverity && matchesCategory && matchesQuery;
  }), [category, query, result, severity]);

  const availableReports = account ? account.freeReportsRemaining + account.reportCredits : 0;

  return (
    <>
      <section className={styles.hero} id="reconciliation-workspace" aria-labelledby="revenue-leak-title">
        <div className={styles.heroIntro}>
          <p className={styles.eyebrow}>Revenue reconciliation</p>
          <h1 id="revenue-leak-title">Find revenue leaks in two CSV exports.</h1>
          <p className={styles.heroCopy}>Add a revenue export and a ledger or CRM export. You’ll get a clear list of missing payments, mismatched amounts, duplicates, and status drift.</p>
          <div className={styles.trustLine}>
            <span><i aria-hidden="true">✓</i> Files stay in your browser</span>
            <span><i aria-hidden="true">✓</i> Deterministic matching</span>
            <span><i aria-hidden="true">✓</i> No AI guesswork</span>
          </div>
        </div>
        <div className={styles.workspace}>
          <div className={styles.workspaceTop}>
            <div className={styles.steps} aria-label="Progress">
              <span className={stage === "upload" ? styles.stepActive : styles.stepDone}>01 <b>Files</b></span>
              <span className={stage === "map" ? styles.stepActive : stage === "results" ? styles.stepDone : ""}>02 <b>Map</b></span>
              <span className={stage === "results" ? styles.stepActive : ""}>03 <b>Review</b></span>
            </div>
            <button className={styles.accountButton} type="button" onClick={() => setAuthOpen(true)}>
              {account ? `${availableReports} report${availableReports === 1 ? "" : "s"} ready` : accountChecked ? "Sign in" : "Checking account…"}
            </button>
          </div>

          {stage === "upload" && (
            <div className={styles.uploadPanel}>
              <div className={styles.panelHeading}>
                <div><span>Start here</span><h2>Choose two exports</h2></div>
                <button type="button" className={styles.demoButton} onClick={loadDemo}>Explore sample data <span aria-hidden="true">→</span></button>
              </div>
              <div className={styles.dropGrid}>
                <FileDrop id="revenue-source" eyebrow="Source A" title="Payments or revenue export" source={left} onFile={(file) => void readFile(file, "left")} />
                <div className={styles.compareMark} aria-hidden="true">vs</div>
                <FileDrop id="ledger-source" eyebrow="Source B" title="Accounting or CRM export" source={right} onFile={(file) => void readFile(file, "right")} />
              </div>
              <div className={styles.uploadFooter}>
                <p>Good pairings: Stripe + QuickBooks, payment processor + HubSpot, invoices + bank settlements.</p>
                <button type="button" disabled={!left || !right} onClick={() => setStage("map")}>Map columns <span aria-hidden="true">→</span></button>
              </div>
            </div>
          )}

          {stage === "map" && left && right && (
            <div className={styles.mapPanel}>
              <div className={styles.panelHeading}>
                <div><span>Column mapping</span><h2>Tell us what each column means</h2></div>
                <button type="button" className={styles.textButton} onClick={() => setStage("upload")}>← Change files</button>
              </div>
              <div className={styles.mappingHeader}>
                <span>Field</span><strong>{left.name}</strong><strong>{right.name}</strong>
              </div>
              <div className={styles.mappingRows}>
                {FIELDS.map((item) => (
                  <div className={styles.mappingRow} key={item.key}>
                    <label htmlFor={`left-${item.key}`}><strong>{item.label}{item.required ? " *" : ""}</strong><small>{item.detail}</small></label>
                    <select id={`left-${item.key}`} value={leftMap[item.key] || ""} onChange={(event) => setLeftMap((current) => ({ ...current, [item.key]: event.target.value || undefined }))}>
                      <option value="">Not mapped</option>{left.table.headers.map((header) => <option key={header}>{header}</option>)}
                    </select>
                    <select aria-label={`${item.label} in ${right.name}`} value={rightMap[item.key] || ""} onChange={(event) => setRightMap((current) => ({ ...current, [item.key]: event.target.value || undefined }))}>
                      <option value="">Not mapped</option>{right.table.headers.map((header) => <option key={header}>{header}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className={styles.mapFooter}>
                <p><span aria-hidden="true">i</span> Match priority: transaction → invoice → customer → email. Amount and date break ties.</p>
                <button type="button" onClick={runAnalysis}>Run reconciliation <span aria-hidden="true">→</span></button>
              </div>
            </div>
          )}

          {stage === "results" && result && (
            <div className={styles.resultsPanel}>
              <div className={styles.resultsTop}>
                <div>
                  <span className={styles.resultKicker}>{demo ? "Sample reconciliation" : authorized ? "Report ready" : "Preview ready"}</span>
                  <h2>{result.issues.length ? `${result.issues.length} exceptions need attention` : "No material exceptions found"}</h2>
                  <p>{result.matchedCount} source records matched · {result.sourceRowCoverage}% source-row coverage</p>
                </div>
                <div className={styles.resultsActions}>
                  <button type="button" className={styles.textButton} onClick={resetWorkspace}>New comparison</button>
                  <button type="button" onClick={downloadReport} disabled={!authorized}>Download report <span aria-hidden="true">↓</span></button>
                </div>
              </div>
              <div className={styles.metrics}>
                <article className={styles.riskMetric}><span>Estimated value at risk</span><strong>{result.currencies.length > 1 ? "Mixed currencies" : formatMoney(result.valueAtRiskCents, result.currencies[0] || "USD")}</strong><small>{moneyBreakdown(result.valueAtRiskByCurrency)}</small></article>
                <article><span>Source total</span><strong>{result.currencies.length > 1 ? "Mixed currencies" : formatMoney(result.leftTotalCents, result.currencies[0] || "USD")}</strong><small>{result.currencies.length > 1 ? moneyBreakdown(result.leftTotalsByCurrency) : left?.name}</small></article>
                <article><span>Ledger total</span><strong>{result.currencies.length > 1 ? "Mixed currencies" : formatMoney(result.rightTotalCents, result.currencies[0] || "USD")}</strong><small>{result.currencies.length > 1 ? moneyBreakdown(result.rightTotalsByCurrency) : right?.name}</small></article>
                <article><span>Source-row coverage</span><strong>{result.sourceRowCoverage}%</strong><small>{result.matchedCount} of {result.leftCount} source rows</small></article>
              </div>

              {!authorized && (
                <div className={styles.reportGate}>
                  <div><span>Full exception evidence is protected</span><h3>{account ? availableReports ? "Use a report to reveal every finding" : "Add report credits to continue" : "Sign in to unlock your first full report"}</h3><p>Raw CSV rows never leave this browser. Your account stores only file names and aggregate report totals.</p></div>
                  {account ? (
                    availableReports ? <button type="button" disabled={busy} onClick={() => void authorizeAnalysis()}>{busy ? "Unlocking…" : "Use 1 report"}</button>
                      : <button type="button" disabled={busy} onClick={() => void buyCredits()}>{busy ? "Opening Stripe…" : "Buy 10 reports · $29"}</button>
                  ) : <button type="button" onClick={() => setAuthOpen(true)}>Sign in · first report free</button>}
                </div>
              )}

              <div className={!authorized ? styles.lockedResults : ""} aria-hidden={!authorized || undefined}>
                <div className={styles.filters}>
                  <div className={styles.severityTabs} aria-label="Filter by severity">
                    {(["all", "high", "medium", "low"] as const).map((value) => <button key={value} type="button" className={severity === value ? styles.filterActive : ""} onClick={() => setSeverity(value)}>{value === "all" ? "All findings" : value}</button>)}
                  </div>
                  <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value as "all" | LeakCategory)}>
                    <option value="all">All categories</option>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input aria-label="Search findings" type="search" placeholder="Search reference or customer" value={query} onChange={(event) => setQuery(event.target.value)} />
                </div>
                <div className={styles.issueTableWrap}>
                  <table className={styles.issueTable}>
                    <thead><tr><th>Priority</th><th>Finding</th><th>Reference</th><th>Value</th><th>Why it was flagged</th><th>Next action</th></tr></thead>
                    <tbody>
                      {filteredIssues.slice(0, 200).map((issue) => (
                        <tr key={issue.id}>
                          <td><span className={`${styles.severity} ${styles[`severity${issue.severity[0].toUpperCase()}${issue.severity.slice(1)}`]}`}>{issue.severity}</span></td>
                          <td><strong>{CATEGORY_LABELS[issue.category]}</strong><small>{sourceLabel(issue.source)}</small></td>
                          <td><strong>{issue.reference}</strong><small>{issue.customer}</small></td>
                          <td><strong>{issue.amountCents ? formatMoney(issue.amountCents, issue.currency) : "—"}</strong><small>{issue.leftRow ? `Source row ${issue.leftRow}` : ""}{issue.leftRow && issue.rightRow ? " · " : ""}{issue.rightRow ? `Ledger row ${issue.rightRow}` : ""}</small></td>
                          <td>{issue.reason}</td><td>{issue.recommendation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!filteredIssues.length && <p className={styles.emptyState}>No findings match these filters.</p>}
                  {filteredIssues.length > 200 && <p className={styles.tableNote}>Showing the first 200 findings. The downloaded report contains all {filteredIssues.length}.</p>}
                </div>
              </div>
            </div>
          )}
          {(error || message) && <div className={`${styles.notice} ${error ? styles.noticeError : ""}`} role={error ? "alert" : "status"}>{error || message}<button type="button" aria-label="Dismiss message" onClick={() => { setError(""); setMessage(""); }}>×</button></div>}
        </div>
      </section>

      <section className={styles.method} id="method" aria-labelledby="method-title">
        <div>
          <p className={styles.eyebrow}>How it works</p>
          <h2 id="method-title">A clear, repeatable reconciliation</h2>
          <p>Every finding follows the same inspectable process and points back to the exact source rows.</p>
        </div>
        <ol>
          <li><span>01</span><div><strong>Normalize</strong><p>Clean IDs, emails, money, dates, currencies, and statuses without changing the source files.</p></div></li>
          <li><span>02</span><div><strong>Match</strong><p>Prefer transaction and invoice IDs; use customer identity, amount, and date only when stronger keys are absent.</p></div></li>
          <li><span>03</span><div><strong>Explain</strong><p>Flag missing rows, duplicates, value and status drift, then attach a practical next check.</p></div></li>
        </ol>
      </section>

      <section className={styles.privacy} id="privacy" aria-labelledby="privacy-title">
        <div><p className={styles.eyebrow}>Privacy by design</p><h2 id="privacy-title">Your CSV data stays on your device.</h2></div>
        <div className={styles.privacyCopy}><p>Parsing and reconciliation happen locally in your browser. The server receives only aggregate totals, file names, and issue counts when a signed-in user saves a report.</p><p>Raw CSV rows, customer emails, transaction IDs, and downloaded reports are never uploaded or stored by Revenue Leak Finder.</p></div>
        {account && (
          <aside className={styles.historyCard}>
            <div><span>Signed in as</span><strong>{account.email}</strong><button type="button" onClick={() => void signOut()}>Sign out</button></div>
            <h3>Recent reports</h3>
            {history.length ? <ul>{history.slice(0, 5).map((item) => {
              const totals = item.summary?.valueAtRiskByCurrency || {};
              const currencies = item.summary?.currencies || Object.keys(totals);
              return <li key={item.id}><span><strong>{item.leftName}</strong> vs {item.rightName}</span><b>{currencies.length > 1 ? `Mixed: ${moneyBreakdown(totals)}` : `${formatMoney(item.valueAtRiskCents, currencies[0] || "USD")} at risk`}</b><small>{item.issueCount} findings · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.createdAt))}</small></li>;
            })}</ul> : <p>No saved reports yet.</p>}
          </aside>
        )}
      </section>

      {authOpen && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className={styles.authModal} role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className={styles.modalClose} type="button" aria-label="Close sign-in" onClick={() => setAuthOpen(false)}>×</button>
            {account ? (
              <>
                <p className={styles.eyebrow}>Intelligent Decisions account</p><h2 id="auth-title">{account.email}</h2>
                <div className={styles.accountStats}><span><strong>{account.freeReportsRemaining}</strong> free report</span><span><strong>{account.reportCredits}</strong> paid credits</span><span><strong>{account.reportsCompleted}</strong> completed</span></div>
                <button type="button" className={styles.modalPrimary} disabled={busy} onClick={availableReports && result && !authorized ? () => void authorizeAnalysis() : () => void buyCredits()}>{availableReports && result && !authorized ? "Unlock this report" : "Buy 10 reports · $29"}</button>
                <button type="button" className={styles.modalSecondary} onClick={() => void signOut()}>Sign out</button>
              </>
            ) : codeSent ? (
              <>
                <p className={styles.eyebrow}>Check your inbox</p><h2 id="auth-title">Enter your six-digit code</h2><p>We sent a one-time sign-in code to <strong>{email}</strong>.</p>
                <form onSubmit={verifyCode}><label htmlFor="rlf-code">Sign-in code</label><input id="rlf-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /><button className={styles.modalPrimary} disabled={busy}>{busy ? "Verifying…" : "Verify and continue"}</button></form>
                <button type="button" className={styles.modalSecondary} onClick={() => { setCodeSent(false); setMessage(""); }}>Use another email</button>
              </>
            ) : (
              <>
                <p className={styles.eyebrow}>First full report free</p><h2 id="auth-title">Save your evidence trail</h2><p>Sign in with a one-time email code. No password, no raw CSV upload.</p>
                <form onSubmit={requestCode}><label htmlFor="rlf-email">Work email</label><input id="rlf-email" type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required /><input className={styles.honeypot} name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" /><div ref={turnstileNode} className={styles.turnstile} /><button className={styles.modalPrimary} disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button></form>
                <p className={styles.authFinePrint}>One free report per account. Then $29 for 10 report credits.</p>
              </>
            )}
            {(error || message) && <p className={error ? styles.modalError : styles.modalMessage}>{error || message}</p>}
          </section>
        </div>
      )}
    </>
  );
}
