import { expect, test } from "@playwright/test";

const pages = [
  ["homepage", "/", /Intelligent Decisions/i],
  ["ADBridge", "/projects/adbridge/", /ADBridge/i],
  ["CourierIQ", "/projects/courieriq/", /CourierIQ/i],
  ["Chargeback Studio", "/projects/chargeback-studio/", /Chargeback Studio/i],
  ["Revenue Leak Finder", "/projects/revenue-leak-finder/", /Revenue Leak Finder/i],
  ["BidLens", "/projects/bidlens/", /BidLens/i],
  ["ScopeFence", "/projects/scopefence/", /ScopeFence/i],
  ["privacy notice", "/privacy/", /Privacy \| Intelligent Decisions Interactive/i],
  ["terms", "/terms/", /Terms \| Intelligent Decisions Interactive/i],
  ["support", "/support/", /Support \| Intelligent Decisions Interactive/i],
  ["contact", "/contact/", /Contact \| Intelligent Decisions Interactive/i],
];

function sameOrigin(url, baseURL) {
  try {
    return new URL(url).origin === new URL(baseURL).origin;
  } catch {
    return false;
  }
}

function isExpectedAnonymousApiResponse(url, status, baseURL) {
  if (!sameOrigin(url, baseURL)) return false;
  return new URL(url).pathname.startsWith("/api/") && [401, 403].includes(status);
}

function isExpectedTurnstileTestNoise(message) {
  try {
    return new URL(message.location().url).hostname === "challenges.cloudflare.com" &&
      /Failed to load resource: the server responded with a status of 400/i.test(message.text());
  } catch {
    return false;
  }
}

for (const [name, path, title] of pages) {
  test(`${name} loads cleanly`, async ({ page, baseURL }) => {
    const browserErrors = [];
    const failedRequests = [];

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (isExpectedTurnstileTestNoise(message)) return;
      const locationUrl = message.location().url;
      if (
        sameOrigin(locationUrl, baseURL) &&
        new URL(locationUrl).pathname.startsWith("/api/") &&
        /status of (401|403)/i.test(message.text())
      ) return;
      browserErrors.push(`console: ${message.text()}${locationUrl ? ` (${locationUrl})` : ""}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      if (
        response.status() >= 400 &&
        sameOrigin(response.url(), baseURL) &&
        !isExpectedAnonymousApiResponse(response.url(), response.status(), baseURL)
      ) failedRequests.push(`${response.status()} ${response.url()}`);
    });
    page.on("requestfailed", (request) => {
      if (sameOrigin(request.url(), baseURL)) {
        failedRequests.push(`${request.failure()?.errorText || "request failed"} ${request.url()}`);
      }
    });

    const response = await page.goto(path, { waitUntil: "load" });
    expect(response, `${name} did not return a navigation response`).not.toBeNull();
    expect(response.status(), `${name} returned ${response.status()}`).toBe(200);
    expect(response.headers()["content-security-policy"], `${name} has no CSP`).toBeTruthy();
    await expect(page).toHaveTitle(title);
    await expect(page.locator("main:visible").first()).toBeVisible();
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(
      overflow.scrollWidth,
      `${name} overflows horizontally: ${overflow.scrollWidth}px > ${overflow.clientWidth}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(failedRequests, `${name} has failed same-origin requests`).toEqual([]);
    expect(browserErrors, `${name} emitted browser errors or CSP violations`).toEqual([]);
  });
}

test("the retired EvidenceLane URL permanently resolves to Chargeback Studio", async ({ page }) => {
  const response = await page.goto("/projects/evidencelane/", { waitUntil: "load" });
  expect(response).not.toBeNull();
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/projects\/chargeback-studio\/$/);
  await expect(page).toHaveTitle(/Chargeback Studio/i);
});

test("ScopeFence exposes verified history and workspace deletion controls", async ({ page }) => {
  const deleted = [];
  const workspace = {
    account: {
      email: "owner@example.com",
      freeAnalysesUsed: 1,
      freeAnalysesLimit: 3,
      freeAnalysesRemaining: 2,
      paidCreditBalance: 0,
      availableAnalyses: 2,
      accessStatus: "active",
    },
    scopes: [{
      id: "22222222-2222-4222-8222-222222222222",
      title: "Client agreement",
      content: "[ScopeFence guided agreement]\n\n## Agreement name\nClient agreement\n\n## Client or project\nNorthstar\n\n## Included deliverables\nFive-page website with two revision rounds.",
      createdAt: "2026-09-12T12:00:00.000Z",
      updatedAt: "2026-09-12T12:00:00.000Z",
    }],
    history: [{
      id: "33333333-3333-4333-8333-333333333333",
      scopeId: "22222222-2222-4222-8222-222222222222",
      scopeTitle: "Client agreement",
      scopeText: "The agreement includes a five-page website with two revision rounds.",
      clientRequest: "[ScopeFence guided request]\n\n## Request headline\nAdd a resource library\n\n## Requested work\nCreate a gated resource library with sixty documents.",
      hourlyRateCents: 12500,
      creditSource: "free",
      createdAt: "2026-09-12T12:30:00.000Z",
      result: {
        verdict: "out_of_scope",
        confidence: "high",
        summary: "The resource library is not included.",
        evidence: [{ quote: "five-page website", explanation: "The deliverable is limited." }],
        assumptions: [],
        impact: { hoursMin: 8, hoursMax: 12, priceMinCents: 100000, priceMaxCents: 150000, rationale: "Additional implementation." },
        clientResponse: { subject: "Resource library scope", body: "This request needs a change order." },
        changeOrder: { title: "Resource library", summary: "Add a gated library.", deliverables: [], exclusions: [], timeline: "One week", approvalTerms: "Written approval" },
        disclaimer: "Planning aid, not legal advice.",
      },
    }],
    user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
  };

  await page.route("**/api/scopefence/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/scopefence/workspace" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
      return;
    }
    if (url.pathname === "/api/scopefence/history" && request.method() === "DELETE") {
      deleted.push("history");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deletedCount: 1 }) });
      return;
    }
    if (url.pathname === "/api/scopefence/account" && request.method() === "DELETE") {
      expect(request.postDataJSON()).toEqual({ confirmation: "owner@example.com" });
      deleted.push("account");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected test route." }) });
  });

  await page.goto("/projects/scopefence/", { waitUntil: "load" });
  await expect(page.getByText("owner@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete saved check for Client agreement" })).toBeVisible();

  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("heading", { name: "Clear saved check history" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText("Saved check history and embedded client requests deleted.")).toBeVisible();

  await page.getByRole("button", { name: "Delete ScopeFence data" }).click();
  await expect(page.getByText(/unused credits/i)).toBeVisible();
  await page.getByLabel(/Enter owner@example\.com to confirm/i).fill("owner@example.com");
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText(/shared IDI sign-in remains available/i)).toBeVisible();
  expect(deleted).toEqual(["history", "account"]);
});
