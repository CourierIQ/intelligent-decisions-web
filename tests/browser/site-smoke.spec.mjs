import { expect, test } from "@playwright/test";

const pages = [
  ["homepage", "/", /Intelligent Decisions/i],
  ["ADBridge", "/projects/adbridge/", /ADBridge/i],
  ["CourierIQ", "/projects/courieriq/", /CourierIQ/i],
  ["Chargeback Studio", "/projects/chargeback-studio/", /Chargeback Studio/i],
  ["Revenue Leak Finder", "/projects/revenue-leak-finder/", /Revenue Leak Finder/i],
  ["BidLens", "/projects/bidlens/", /BidLens/i],
  ["ScopeFence", "/projects/scopefence/", /ScopeFence/i],
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
