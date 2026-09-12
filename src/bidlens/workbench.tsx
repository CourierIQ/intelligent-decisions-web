"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { BidLensProduct } from "./products";
import type { BidLensAnalysis, BidLensHistoryItem, BidLensWorkspaceData } from "./types";
import styles from "./bidlens.module.css";

type ReportTab = "requirements" | "risks" | "deadlines" | "questions" | "outline";
type InputMode = "file" | "text";

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_KEY = "0x4AAAAAADzePhY2Hgvp3XUu";
const ACCEPTED_FILES = ".pdf,.doc,.docx,.rtf,.odt,.txt,.md";

function turnstileApi() {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
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

function recommendationLabel(value: BidLensAnalysis["score"]["recommendation"]) {
  return ({ bid: "Bid", conditional_bid: "Conditional bid", no_bid: "No bid" })[value];
}

function complianceLabel(value: BidLensAnalysis["requirements"][number]["compliance"]) {
  return ({ clear: "Clear", needs_confirmation: "Confirm", gap: "Gap" })[value];
}

function dateLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !value.includes("T")) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function relativeDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function reportMarkdown(title: string, analysis: BidLensAnalysis) {
  const lines = [
    `# ${title}`,
    "",
    `**Decision:** ${recommendationLabel(analysis.score.recommendation)} — ${analysis.score.total}/100`,
    "",
    analysis.summary,
    "",
    "## Requirements matrix",
    "",
    "| ID | Requirement | Status | Evidence | Owner |",
    "| --- | --- | --- | --- | --- |",
    ...analysis.requirements.map((item) => `| ${item.id} | ${item.requirement.replace(/\|/g, "\\|")} | ${complianceLabel(item.compliance)} | ${item.evidence.replace(/\|/g, "\\|")} | ${item.responseOwner} |`),
    "",
    "## Missing information",
    "",
    ...analysis.missingInformation.map((item) => `- **${item.item} (${item.priority})** — ${item.whyItMatters}`),
    "",
    "## Risky terms",
    "",
    ...analysis.riskyTerms.map((item) => `- **${item.term} (${item.severity})** — ${item.impact} Evidence: ${item.evidence}`),
    "",
    "## Deadlines",
    "",
    ...analysis.deadlines.map((item) => `- **${item.event}:** ${item.date} (${item.timeZone}) — ${item.evidence}`),
    "",
    "## Clarifying questions",
    "",
    ...analysis.clarifyingQuestions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Proposal outline",
    "",
    ...analysis.proposalOutline.flatMap((item) => [`### ${item.section}`, item.purpose, ...item.keyPoints.map((point) => `- ${point}`), ""]),
    "",
    `_${analysis.confidenceNote}_`,
  ];
  return lines.join("\n");
}

export function BidLensWorkbench({
  sample,
  products,
}: {
  sample: BidLensAnalysis;
  products: readonly BidLensProduct[];
}) {
  const [workspace, setWorkspace] = useState<BidLensWorkspaceData | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [inputMode, setInputMode] = useState<InputMode>("file");
  const [reportTab, setReportTab] = useState<ReportTab>("requirements");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [activeReport, setActiveReport] = useState<{ title: string; analysis: BidLensAnalysis; id?: string }>(
    { title: "Sample: Civic technology modernization", analysis: sample },
  );
  const [sampleVisible, setSampleVisible] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const turnstileNode = useRef<HTMLDivElement>(null);
  const turnstileId = useRef("");
  const turnstileToken = useRef("");
  const previousFocus = useRef<HTMLElement | null>(null);

  const report = activeReport.analysis;
  const canAnalyze = inputMode === "file" ? Boolean(file) : text.trim().length >= 120;

  async function loadWorkspace() {
    const response = await fetch("/api/bidlens/account", { cache: "no-store" });
    if (response.ok) {
      const data = await responseJson<{ workspace: BidLensWorkspaceData }>(response);
      setWorkspace(data.workspace);
      return;
    }
    if (response.status !== 401) throw new Error("Your saved reports could not be loaded.");
    const refreshed = await fetch("/api/bidlens/auth/refresh", { method: "POST" });
    if (!refreshed.ok) {
      setWorkspace(null);
      return;
    }
    const data = await responseJson<{ workspace: BidLensWorkspaceData }>(refreshed);
    setWorkspace(data.workspace);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    // Session discovery is this effect's external synchronization target.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWorkspace()
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Your saved reports could not be loaded."))
      .finally(() => setAccountLoading(false));
    if (payment === "success") setMessage("Payment received. Stripe is confirming your credits; they will appear shortly.");
    if (payment === "cancelled") setMessage("Checkout cancelled. No charge was made.");
    if (payment) window.history.replaceState({}, "", "/projects/bidlens/");
  }, []);

  useEffect(() => {
    if (!authOpen || codeSent || workspace || !turnstileNode.current) return;
    let cancelled = false;
    function render() {
      const api = turnstileApi();
      if (!api || !turnstileNode.current || cancelled || turnstileId.current) return;
      turnstileId.current = api.render(turnstileNode.current, {
        sitekey: TURNSTILE_KEY,
        action: "bidlens_account",
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
  }, [authOpen, codeSent, workspace]);

  useEffect(() => {
    if (!authOpen && !upgradeOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAuthOpen(false);
      setUpgradeOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [authOpen, upgradeOpen]);

  function clearNotices() {
    setError("");
    setMessage("");
  }

  function selectFile(nextFile: File | null) {
    clearNotices();
    if (nextFile && nextFile.size > 8 * 1024 * 1024) {
      setError("Documents must be 8 MB or smaller.");
      return;
    }
    setFile(nextFile);
    if (nextFile && !title) setTitle(nextFile.name.replace(/\.[^.]+$/, "").slice(0, 160));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] || null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] || null);
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearNotices();
    if (!workspace) {
      setAuthOpen(true);
      return;
    }
    if (workspace.account.creditBalance < 1) {
      setUpgradeOpen(true);
      return;
    }
    if (!canAnalyze) return;
    setAnalyzing(true);
    const form = new FormData();
    form.set("title", title);
    if (inputMode === "file" && file) form.set("file", file);
    if (inputMode === "text") form.set("text", text.trim());
    try {
      const data = await responseJson<{
        analysis: BidLensHistoryItem;
        workspace: BidLensWorkspaceData;
      }>(await fetch("/api/bidlens/analyze", { method: "POST", body: form }));
      setWorkspace(data.workspace);
      setActiveReport({ title: data.analysis.title, analysis: data.analysis.analysis, id: data.analysis.id });
      setSampleVisible(false);
      setReportTab("requirements");
      setMessage("Analysis complete and saved to your private history.");
    } catch (reason) {
      const typed = reason as Error & { code?: string };
      if (typed.code === "credits_required") setUpgradeOpen(true);
      setError(typed.message || "BidLens could not complete the analysis.");
      await loadWorkspace().catch(() => undefined);
    } finally {
      setAnalyzing(false);
    }
  }

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearNotices();
    if (!turnstileToken.current) {
      setError("Complete the security check first.");
      return;
    }
    setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await responseJson(await fetch("/api/bidlens/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website: form.get("website"), turnstileToken: turnstileToken.current }),
      }));
      setCodeSent(true);
      setMessage("A six-digit sign-in code is on its way.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A code could not be sent.");
      turnstileToken.current = "";
      turnstileApi()?.reset(turnstileId.current);
    } finally {
      setAuthBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearNotices();
    setAuthBusy(true);
    const code = new FormData(event.currentTarget).get("code");
    try {
      const data = await responseJson<{ workspace: BidLensWorkspaceData }>(await fetch("/api/bidlens/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      }));
      setWorkspace(data.workspace);
      setCodeSent(false);
      setAuthOpen(false);
      setMessage("Signed in. Two complimentary analysis credits are ready.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That code could not be verified.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    clearNotices();
    await fetch("/api/bidlens/auth/logout", { method: "POST" });
    setWorkspace(null);
    setActiveReport({ title: "Sample: Civic technology modernization", analysis: sample });
    setSampleVisible(true);
    setMessage("Signed out.");
  }

  async function startCheckout(sku: string) {
    clearNotices();
    setCheckoutBusy(sku);
    try {
      const data = await responseJson<{ checkoutUrl: string }>(await fetch("/api/bidlens/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, idempotencyKey: crypto.randomUUID() }),
      }));
      window.location.assign(data.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Checkout could not be started.");
      setCheckoutBusy("");
    }
  }

  function openHistory(item: BidLensHistoryItem) {
    setActiveReport({ title: item.title, analysis: item.analysis, id: item.id });
    setSampleVisible(false);
    setReportTab("requirements");
    document.getElementById("report")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteHistory(item: BidLensHistoryItem) {
    if (!window.confirm(`Delete “${item.title}” from BidLens history? This cannot be undone.`)) return;
    clearNotices();
    try {
      await responseJson(await fetch(`/api/bidlens/history/${item.id}`, { method: "DELETE" }));
      setWorkspace((current) => current ? { ...current, history: current.history.filter((entry) => entry.id !== item.id) } : current);
      if (activeReport.id === item.id) {
        setActiveReport({ title: "Sample: Civic technology modernization", analysis: sample });
        setSampleVisible(true);
      }
      setMessage("Saved report deleted.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The report could not be deleted.");
    }
  }

  function downloadReport() {
    const blob = new Blob([reportMarkdown(activeReport.title, report)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeReport.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bidlens-report"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const reportCounts = useMemo(() => ({
    requirements: report.requirements.length,
    risks: report.riskyTerms.length + report.missingInformation.length,
    deadlines: report.deadlines.length,
    questions: report.clarifyingQuestions.length,
    outline: report.proposalOutline.length,
  }), [report]);

  return (
    <div className={styles.workspace} id="bidlens-workspace">
      <aside className={styles.rail} aria-label="BidLens account and history">
        <section className={styles.railAccount}>
          <p className={styles.eyebrow}>Workspace</p>
          {accountLoading ? (
            <div className={styles.accountSkeleton}><span /><span /></div>
          ) : workspace ? (
            <>
              <strong className={styles.accountEmail}>{workspace.account.email}</strong>
              <div className={styles.creditReadout}>
                <span>{workspace.account.creditBalance}</span>
                <p>analysis {workspace.account.creditBalance === 1 ? "credit" : "credits"}</p>
              </div>
              <div className={styles.railActions}>
                <button type="button" onClick={() => setUpgradeOpen(true)}>Add credits</button>
                <button type="button" onClick={signOut}>Sign out</button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.railCopy}>Sign in to analyze documents and keep your reports private.</p>
              <button className={styles.railPrimary} type="button" onClick={() => setAuthOpen(true)}>Sign in / create account</button>
              <small>Includes 2 complimentary analyses.</small>
            </>
          )}
        </section>

        <section className={styles.historySection}>
          <div className={styles.railHeading}>
            <p className={styles.eyebrow}>Recent analyses</p>
            {workspace?.history.length ? <span>{workspace.history.length}</span> : null}
          </div>
          {workspace?.history.length ? (
            <div className={styles.historyList}>
              {workspace.history.map((item) => (
                <article className={activeReport.id === item.id ? styles.historyActive : ""} key={item.id}>
                  <button type="button" onClick={() => openHistory(item)}>
                    <span>{item.score}</span>
                    <div><strong>{item.title}</strong><small>{relativeDate(item.createdAt)} · {fileSize(item.sourceSize)}</small></div>
                  </button>
                  <button className={styles.deleteButton} type="button" aria-label={`Delete ${item.title}`} onClick={() => deleteHistory(item)}>×</button>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyHistory}>
              <span aria-hidden="true">01</span>
              <p>{workspace ? "Your completed analyses will appear here." : "History is available after sign-in."}</p>
            </div>
          )}
        </section>

        <div className={styles.privacyNote}>
          <span aria-hidden="true">⌁</span>
          <p><strong>Source files are ephemeral.</strong> BidLens processes the upload in memory and never saves the original document or pasted text.</p>
        </div>
      </aside>

      <div className={styles.mainColumn}>
        <section className={styles.intake} aria-labelledby="intake-title">
          <div className={styles.intakeIntro}>
            <p className={styles.eyebrow}>Opportunity triage / one complete pass</p>
            <h1 id="intake-title">See the bid<br /><em>before you write it.</em></h1>
            <p>Turn an RFP into a requirements matrix, risk register, deadline brief, decision score, questions, and a proposal plan.</p>
          </div>

          <form className={styles.intakeForm} onSubmit={analyze}>
            <div className={styles.modeSwitch} role="tablist" aria-label="RFP input type">
              <button type="button" role="tab" aria-selected={inputMode === "file"} onClick={() => { setInputMode("file"); clearNotices(); }}>Upload document</button>
              <button type="button" role="tab" aria-selected={inputMode === "text"} onClick={() => { setInputMode("text"); clearNotices(); }}>Paste text</button>
            </div>

            <label className={styles.titleField}>
              <span>Opportunity name <small>Optional</small></span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="e.g. Statewide case management modernization" />
            </label>

            {inputMode === "file" ? (
              <div
                className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ""} ${file ? styles.dropzoneReady : ""}`}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input ref={fileInput} type="file" accept={ACCEPTED_FILES} onChange={onFileChange} aria-label="Choose RFP document" />
                {file ? (
                  <>
                    <div className={styles.fileIcon} aria-hidden="true">RFP</div>
                    <div><strong>{file.name}</strong><span>{fileSize(file.size)} · Ready for secure analysis</span></div>
                    <button type="button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove</button>
                  </>
                ) : (
                  <>
                    <div className={styles.uploadGlyph} aria-hidden="true">↑</div>
                    <div><strong>Drop the RFP here</strong><span>PDF, Word, RTF, ODT, TXT, or Markdown · 8 MB max</span></div>
                    <button type="button" onClick={() => fileInput.current?.click()}>Choose file</button>
                  </>
                )}
              </div>
            ) : (
              <label className={styles.textField}>
                <span className={styles.srOnly}>Paste RFP text</span>
                <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={750000} placeholder="Paste the RFP, statement of work, or solicitation text here…" />
                <small>{text.trim().length.toLocaleString()} characters · minimum 120</small>
              </label>
            )}

            <div className={styles.submitRow}>
              <div>
                <span className={styles.secureBadge}>Private by design</span>
                <p>Only the structured report is saved. Delete it anytime.</p>
              </div>
              <button className={styles.analyzeButton} type="submit" disabled={!canAnalyze || analyzing}>
                {analyzing ? <><i /> Reading the RFP…</> : <>Analyze opportunity <span aria-hidden="true">↗</span></>}
              </button>
            </div>
          </form>
        </section>

        {(error || message) && (
          <div className={`${styles.notice} ${error ? styles.noticeError : styles.noticeSuccess}`} role={error ? "alert" : "status"}>
            <span aria-hidden="true">{error ? "!" : "✓"}</span>
            <p>{error || message}</p>
            <button type="button" onClick={clearNotices} aria-label="Dismiss notification">×</button>
          </div>
        )}

        <section className={styles.report} id="report" aria-labelledby="report-title">
          <div className={styles.reportHeader}>
            <div>
              <p className={styles.eyebrow}>{sampleVisible ? "Interactive sample" : "Saved analysis"}</p>
              <h2 id="report-title">{activeReport.title}</h2>
              <p>{report.summary}</p>
            </div>
            <div className={`${styles.scoreCard} ${styles[`score_${report.score.recommendation}`]}`}>
              <span><strong>{report.score.total}</strong>/100</span>
              <p>{recommendationLabel(report.score.recommendation)}</p>
            </div>
          </div>

          <div className={styles.scoreFactors} aria-label="Bid score factors">
            {report.score.factors.map((factor) => (
              <div key={factor.label} title={factor.rationale}>
                <span><strong>{factor.label}</strong><small>{factor.score}/{factor.maxScore}</small></span>
                <i><b style={{ width: `${(factor.score / factor.maxScore) * 100}%` }} /></i>
              </div>
            ))}
          </div>
          <p className={styles.scoreRationale}>{report.score.rationale}</p>

          <div className={styles.reportToolbar}>
            <div className={styles.reportTabs} role="tablist" aria-label="Analysis sections">
              {(["requirements", "risks", "deadlines", "questions", "outline"] as ReportTab[]).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={reportTab === tab} onClick={() => setReportTab(tab)}>
                  {tab}<span>{reportCounts[tab]}</span>
                </button>
              ))}
            </div>
            <button className={styles.exportButton} type="button" onClick={downloadReport}>Export .md <span aria-hidden="true">↓</span></button>
          </div>

          <div className={styles.reportBody} role="tabpanel">
            {reportTab === "requirements" && (
              <div className={styles.matrixWrap}>
                <table className={styles.matrix}>
                  <thead><tr><th>ID</th><th>Requirement</th><th>Status</th><th>Evidence</th><th>Owner</th></tr></thead>
                  <tbody>{report.requirements.map((item) => (
                    <tr key={item.id}>
                      <td>{item.id}</td>
                      <td><span>{item.category}</span><strong>{item.requirement}</strong></td>
                      <td><i className={styles[`status_${item.compliance}`]}>{complianceLabel(item.compliance)}</i></td>
                      <td>{item.evidence}</td>
                      <td>{item.responseOwner}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}

            {reportTab === "risks" && (
              <div className={styles.riskLayout}>
                <div>
                  <div className={styles.sectionHeading}><p>Risky terms</p><span>{report.riskyTerms.length} found</span></div>
                  <div className={styles.riskList}>{report.riskyTerms.map((item, index) => (
                    <article key={`${item.term}-${index}`}>
                      <span className={styles[`severity_${item.severity}`]}>{item.severity}</span>
                      <h3>{item.term}</h3>
                      <p>{item.impact}</p>
                      <blockquote>{item.evidence}</blockquote>
                    </article>
                  ))}</div>
                </div>
                <div>
                  <div className={styles.sectionHeading}><p>Missing information</p><span>{report.missingInformation.length} gaps</span></div>
                  <div className={styles.gapList}>{report.missingInformation.map((item, index) => (
                    <article key={`${item.item}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{item.item}</h3><p>{item.whyItMatters}</p></div><i>{item.priority}</i></article>
                  ))}</div>
                </div>
              </div>
            )}

            {reportTab === "deadlines" && (
              <div className={styles.timeline}>{report.deadlines.map((item, index) => (
                <article key={`${item.event}-${index}`}>
                  <div><span>{String(index + 1).padStart(2, "0")}</span><i /></div>
                  <div><p>{item.event}</p><h3>{dateLabel(item.date)}</h3><small>{item.timeZone}</small></div>
                  <blockquote>{item.evidence}</blockquote>
                  <em>{item.confidence} confidence</em>
                </article>
              ))}</div>
            )}

            {reportTab === "questions" && (
              <ol className={styles.questionList}>{report.clarifyingQuestions.map((item, index) => (
                <li key={`${item}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p><button type="button" onClick={() => navigator.clipboard?.writeText(item)} aria-label={`Copy question ${index + 1}`}>Copy</button></li>
              ))}</ol>
            )}

            {reportTab === "outline" && (
              <div className={styles.outline}>{report.proposalOutline.map((item, index) => (
                <article key={`${item.section}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><h3>{item.section}</h3><p>{item.purpose}</p><ul>{item.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></div>
                </article>
              ))}</div>
            )}
          </div>
          <p className={styles.confidence}>{report.confidenceNote}</p>
        </section>
      </div>

      {authOpen && !workspace && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className={styles.modalClose} type="button" onClick={() => setAuthOpen(false)} aria-label="Close sign-in" autoFocus>×</button>
            <p className={styles.eyebrow}>Secure workspace</p>
            <h2 id="auth-title">{codeSent ? "Check your inbox." : "Keep your bid work private."}</h2>
            <p>{codeSent ? `Enter the six-digit code sent to ${email}.` : "Sign in with a one-time email code. No password to store or reuse."}</p>
            {codeSent ? (
              <form className={styles.authForm} onSubmit={verifyCode}>
                <label>Six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>
                <button type="submit" disabled={authBusy}>{authBusy ? "Verifying…" : "Open my workspace"}</button>
                <button className={styles.textButton} type="button" onClick={() => { setCodeSent(false); clearNotices(); }}>Use a different email</button>
              </form>
            ) : (
              <form className={styles.authForm} onSubmit={requestCode}>
                <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} required placeholder="you@company.com" /></label>
                <label className={styles.honeypot} aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
                <div ref={turnstileNode} className={styles.turnstile} />
                <button type="submit" disabled={authBusy}>{authBusy ? "Sending…" : "Email my sign-in code"}</button>
              </form>
            )}
            <small>New accounts include 2 complimentary analyses. We use your email only for account access and receipts.</small>
          </section>
        </div>
      )}

      {upgradeOpen && workspace && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUpgradeOpen(false); }}>
          <section className={`${styles.modal} ${styles.upgradeModal}`} role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
            <button className={styles.modalClose} type="button" onClick={() => setUpgradeOpen(false)} aria-label="Close credit options" autoFocus>×</button>
            <p className={styles.eyebrow}>Analysis credits</p>
            <h2 id="upgrade-title">Choose the next set of bids.</h2>
            <p>One credit produces one complete report. Credits do not expire; no subscription required.</p>
            <div className={styles.packGrid}>{products.map((product) => (
              <button key={product.sku} type="button" onClick={() => startCheckout(product.sku)} disabled={Boolean(checkoutBusy)}>
                <span>{product.credits}<small>analyses</small></span>
                <strong>${product.priceCents / 100}</strong>
                <i>{checkoutBusy === product.sku ? "Opening Stripe…" : `$${(product.priceCents / 100 / product.credits).toFixed(2)} each →`}</i>
              </button>
            ))}</div>
            <small>Secure checkout is handled by Stripe. Taxes may be added based on billing location.</small>
          </section>
        </div>
      )}

      {analyzing && (
        <div className={styles.processing} role="status" aria-live="polite">
          <div className={styles.processingLens}><i /><span /></div>
          <p>Reading the opportunity</p>
          <h2>Finding every obligation,<br />date, gap, and decision signal.</h2>
          <div className={styles.processingSteps}><span>Requirements</span><span>Commercial terms</span><span>Bid score</span><span>Response plan</span></div>
          <small>Most RFPs take under two minutes. Keep this tab open.</small>
        </div>
      )}
    </div>
  );
}
