import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bidLensInternals, isBidLensStripeEvent } from "../src/bidlens-api.js";
import { isScopeFenceStripeEvent, scopeFenceInternals } from "../src/scopefence-api.js";

function bidLensFixture() {
  return {
    summary: "A grounded report.",
    requirements: [{ id: "R-1", requirement: "Submit by Friday", category: "Schedule", compliance: "clear", evidence: "Submit by Friday", responseOwner: "Proposal lead" }],
    missingInformation: [],
    riskyTerms: [{ term: "Insurance", severity: "high", evidence: "Maintain insurance", impact: "Coverage cost" }],
    deadlines: [{ event: "Submission", date: "2026-10-02", timeZone: "ET", evidence: "Submit by Friday", confidence: "high" }],
    score: {
      total: 100,
      recommendation: "bid",
      rationale: "Model-supplied total is ignored.",
      factors: [
        { label: "information quality", score: 8, maxScore: 20, rationale: "x" },
        { label: "strategic fit", score: 10, maxScore: 20, rationale: "x" },
        { label: "ability to win", score: 9, maxScore: 20, rationale: "x" },
        { label: "delivery confidence", score: 7, maxScore: 20, rationale: "x" },
        { label: "commercial quality", score: 6, maxScore: 20, rationale: "x" },
      ],
    },
    clarifyingQuestions: [],
    proposalOutline: [],
    confidenceNote: "Verify the source.",
  };
}

test("BidLens recomputes score integrity and downgrades unsupported evidence", () => {
  const analysis = bidLensInternals.normalizeAnalysis(bidLensFixture());
  assert.equal(analysis.score.total, 40);
  assert.equal(analysis.score.recommendation, "no_bid");
  assert.deepEqual(analysis.score.factors.map((factor) => factor.label), [
    "strategic fit", "ability to win", "delivery confidence", "commercial quality", "information quality",
  ]);
  bidLensInternals.applyGrounding(analysis, new Set(["requirement:0", "deadline:0"]));
  assert.equal(analysis.riskyTerms.length, 0);
  assert.equal(analysis.requirements[0].evidence, "Submit by Friday");
  assert.match(analysis.confidenceNote, /unsupported evidence item/);
});

test("ScopeFence keeps only exact agreement quotes and downgrades an ungrounded verdict", () => {
  const raw = {
    verdict: "out_of_scope", confidence: "high", summary: "Extra work.",
    evidence: [{ quote: "Two revision rounds", explanation: "Included limit" }, { quote: "Unlimited revisions", explanation: "Invented" }],
    assumptions: [], impact: { hours_min: 2, hours_max: 4, rationale: "Estimate" },
    client_response: { subject: "Scope update", body: "Please approve." },
    change_order: { title: "Change", summary: "Extra", deliverables: [], exclusions: [], timeline: "2 days", approval_terms: "Written approval" },
  };
  const grounded = scopeFenceInternals.normalizeAnalysis(raw, "The agreement includes Two revision rounds.", 10000);
  assert.equal(grounded.evidence.length, 1);
  assert.equal(grounded.verdict, "out_of_scope");
  const ungrounded = scopeFenceInternals.normalizeAnalysis({ ...raw, evidence: [{ quote: "Invented", explanation: "No" }] }, "Original scope only", 10000);
  assert.equal(ungrounded.verdict, "ambiguous");
  assert.equal(ungrounded.confidence, "low");
});

test("the central Stripe webhook can identify both product purchase events", () => {
  assert.equal(isBidLensStripeEvent({ type: "checkout.session.completed", data: { object: { object: "checkout.session", metadata: { bidlens_flow: "credit_pack_v1" } } } }), true);
  assert.equal(isScopeFenceStripeEvent({ type: "checkout.session.completed", data: { object: { object: "checkout.session", metadata: { scopefence_flow: "credit_pack_web_v1" } } } }), true);
  assert.equal(isBidLensStripeEvent({ type: "checkout.session.completed", data: { object: { object: "checkout.session", metadata: { scopefence_flow: "credit_pack_web_v1" } } } }), false);
});

test("production routes, cookies, origins, storage flags, and webhook endpoints are isolated", async () => {
  const [worker, platform, bidlens, scopefence, home, sitemap] = await Promise.all([
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../src/product-platform.js", import.meta.url), "utf8"),
    readFile(new URL("../src/bidlens-api.js", import.meta.url), "utf8"),
    readFile(new URL("../src/scopefence-api.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /\/api\/bidlens\//);
  assert.match(worker, /\/api\/scopefence\//);
  assert.match(worker, /fulfillBidLensStripeEvent/);
  assert.match(worker, /fulfillScopeFenceStripeEvent/);
  assert.match(worker, /Strict-Transport-Security/);
  assert.match(platform, /intelligentdecisions\.io/);
  assert.match(bidlens, /idi_bidlens_access/);
  assert.match(scopefence, /idi_scopefence_access/);
  assert.match(bidlens, /store: false/);
  assert.match(scopefence, /store: false/);
  assert.match(bidlens, /\/api\/bidlens\/stripe\/webhook/);
  assert.match(scopefence, /\/api\/scopefence\/stripe\/webhook/);
  assert.doesNotMatch(`${bidlens}\n${scopefence}`, /idistudios|sofakingbannon|localhost|autobattle/i);
  assert.match(home, /\/projects\/bidlens\//);
  assert.match(home, /\/projects\/scopefence\//);
  assert.match(sitemap, /projects\/revenue-leak-finder/);
  assert.match(sitemap, /projects\/bidlens/);
  assert.match(sitemap, /projects\/scopefence/);
});
