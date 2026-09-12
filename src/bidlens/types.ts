export type BidLensRecommendation = "bid" | "conditional_bid" | "no_bid";

export type BidLensAnalysis = {
  summary: string;
  requirements: Array<{
    id: string;
    requirement: string;
    category: string;
    compliance: "clear" | "needs_confirmation" | "gap";
    evidence: string;
    responseOwner: string;
  }>;
  missingInformation: Array<{
    item: string;
    whyItMatters: string;
    priority: "high" | "medium" | "low";
  }>;
  riskyTerms: Array<{
    term: string;
    severity: "high" | "medium" | "low";
    evidence: string;
    impact: string;
  }>;
  deadlines: Array<{
    event: string;
    date: string;
    timeZone: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
  }>;
  score: {
    total: number;
    recommendation: BidLensRecommendation;
    rationale: string;
    factors: Array<{
      label: string;
      score: number;
      maxScore: number;
      rationale: string;
    }>;
  };
  clarifyingQuestions: string[];
  proposalOutline: Array<{
    section: string;
    purpose: string;
    keyPoints: string[];
  }>;
  confidenceNote: string;
};

export type BidLensHistoryItem = {
  id: string;
  title: string;
  sourceType: "file" | "text";
  sourceFilename: string | null;
  sourceSize: number;
  score: number;
  recommendation: BidLensRecommendation;
  analysis: BidLensAnalysis;
  createdAt: string;
};

export type BidLensAccount = {
  userId: string;
  email: string;
  creditBalance: number;
  lifetimeCredits: number;
  createdAt: string;
  updatedAt: string;
};

export type BidLensWorkspaceData = {
  account: BidLensAccount;
  history: BidLensHistoryItem[];
};
