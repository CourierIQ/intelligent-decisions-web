import type { BidLensAnalysis } from "./types";

export const BIDLENS_SAMPLE_ANALYSIS: BidLensAnalysis = {
  summary:
    "The opportunity is strategically aligned, but the delivery window is compressed and three commercial terms need resolution before committing.",
  requirements: [
    {
      id: "R-01",
      requirement: "Provide a secure implementation plan covering discovery, configuration, migration, training, and launch.",
      category: "Delivery",
      compliance: "clear",
      evidence: "Section 3.2 — Scope of Services",
      responseOwner: "Delivery lead",
    },
    {
      id: "R-02",
      requirement: "Demonstrate three comparable public-sector deployments completed within the last five years.",
      category: "Experience",
      compliance: "needs_confirmation",
      evidence: "Section 4.1 — Minimum Qualifications",
      responseOwner: "Capture manager",
    },
    {
      id: "R-03",
      requirement: "Accept unlimited liability for confidentiality and data-security events.",
      category: "Commercial",
      compliance: "gap",
      evidence: "Draft Agreement §12.4",
      responseOwner: "Legal",
    },
    {
      id: "R-04",
      requirement: "Submit separate technical and pricing volumes through the procurement portal.",
      category: "Submission",
      compliance: "clear",
      evidence: "Section 6 — Proposal Instructions",
      responseOwner: "Proposal manager",
    },
  ],
  missingInformation: [
    {
      item: "Current user count and annual growth forecast",
      whyItMatters: "Licensing and migration effort cannot be priced defensibly without a volume baseline.",
      priority: "high",
    },
    {
      item: "Required data residency region",
      whyItMatters: "The draft security schedule references residency but does not name an approved region.",
      priority: "high",
    },
    {
      item: "Incumbent transition obligations",
      whyItMatters: "The timeline assumes access to source exports without assigning responsibility.",
      priority: "medium",
    },
  ],
  riskyTerms: [
    {
      term: "Unlimited security liability",
      severity: "high",
      evidence: "Draft Agreement §12.4: liability cap does not apply to confidentiality or security claims.",
      impact: "Potential exposure materially exceeds contract value and insurance limits.",
    },
    {
      term: "Payment after final acceptance",
      severity: "medium",
      evidence: "Draft Agreement §7.2 ties all implementation fees to final acceptance.",
      impact: "Creates significant working-capital exposure across the implementation period.",
    },
    {
      term: "30-day termination for convenience",
      severity: "medium",
      evidence: "Draft Agreement §15.1 permits termination without committed cost recovery.",
      impact: "Non-cancellable third-party and staffing costs may be stranded.",
    },
  ],
  deadlines: [
    {
      event: "Questions due",
      date: "2026-10-02T17:00:00-04:00",
      timeZone: "America/New_York",
      evidence: "RFP cover page — October 2, 2026 at 5:00 PM ET",
      confidence: "high",
    },
    {
      event: "Proposal due",
      date: "2026-10-16T14:00:00-04:00",
      timeZone: "America/New_York",
      evidence: "Section 1.4 — October 16, 2026 at 2:00 PM ET",
      confidence: "high",
    },
    {
      event: "Anticipated award",
      date: "2026-11-20",
      timeZone: "Not stated",
      evidence: "Procurement schedule — Week of November 20",
      confidence: "medium",
    },
  ],
  score: {
    total: 68,
    recommendation: "conditional_bid",
    rationale:
      "Proceed only if legal can narrow the liability carve-out and delivery confirms resource availability for the accelerated start.",
    factors: [
      { label: "Strategic fit", score: 18, maxScore: 20, rationale: "Strong sector and solution alignment." },
      { label: "Ability to win", score: 14, maxScore: 20, rationale: "Relevant experience, but references need confirmation." },
      { label: "Delivery confidence", score: 13, maxScore: 20, rationale: "Compressed schedule creates staffing risk." },
      { label: "Commercial quality", score: 9, maxScore: 20, rationale: "Liability and payment terms require negotiation." },
      { label: "Information quality", score: 14, maxScore: 20, rationale: "Core scope is clear; volumes and residency are missing." },
    ],
  },
  clarifyingQuestions: [
    "What are the current and projected licensed-user counts by user type?",
    "Which data-residency regions are acceptable for production and disaster recovery?",
    "Will the agency accept milestone billing tied to objective deliverables?",
    "Is the agency open to a mutually agreed liability cap for confidentiality and security claims?",
    "What exports, documentation, and transition support will the incumbent provide?",
  ],
  proposalOutline: [
    {
      section: "Executive response",
      purpose: "Frame the agency outcome, our approach, and the reasons to select us.",
      keyPoints: ["Outcome-led opening", "Low-risk transition", "Named accountable team"],
    },
    {
      section: "Technical approach",
      purpose: "Map the proposed solution and controls to each technical requirement.",
      keyPoints: ["Architecture", "Security and residency", "Integration approach"],
    },
    {
      section: "Implementation plan",
      purpose: "Show how discovery through launch fits the required schedule.",
      keyPoints: ["Phases and milestones", "Agency dependencies", "Acceptance criteria"],
    },
    {
      section: "Experience and team",
      purpose: "Prove delivery capability with comparable outcomes and named personnel.",
      keyPoints: ["Three references", "Role matrix", "Relevant credentials"],
    },
    {
      section: "Commercial response",
      purpose: "Present transparent pricing, assumptions, and requested exceptions.",
      keyPoints: ["Price schedule", "Assumptions", "Contract exceptions"],
    },
  ],
  confidenceNote:
    "High confidence in submission requirements and dates. Commercial scoring should be revisited after answers to bidder questions.",
};
