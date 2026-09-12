export type ScopeFenceVerdict = "included" | "ambiguous" | "out_of_scope";

export type ScopeFenceEvidence = {
  quote: string;
  explanation: string;
};
export type ScopeFenceAnalysis = {
  verdict: ScopeFenceVerdict;
  confidence: "low" | "medium" | "high";
  summary: string;
  evidence: ScopeFenceEvidence[];
  assumptions: string[];
  impact: {
    hoursMin: number;
    hoursMax: number;
    priceMinCents: number;
    priceMaxCents: number;
    rationale: string;
  };
  clientResponse: {
    subject: string;
    body: string;
  };
  changeOrder: {
    title: string;
    summary: string;
    deliverables: string[];
    exclusions: string[];
    timeline: string;
    approvalTerms: string;
  };
  disclaimer: string;
};

export type ScopeFenceSavedScope = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type ScopeFenceHistoryItem = {
  id: string;
  scopeId: string | null;
  scopeTitle: string;
  scopeText: string;
  clientRequest: string;
  hourlyRateCents: number;
  creditSource: "free" | "paid";
  result: ScopeFenceAnalysis;
  createdAt: string;
};

export type ScopeFenceAccount = {
  email: string;
  freeAnalysesUsed: number;
  freeAnalysesLimit: number;
  freeAnalysesRemaining: number;
  paidCreditBalance: number;
  availableAnalyses: number;
  accessStatus: "active" | "suspended";
};
