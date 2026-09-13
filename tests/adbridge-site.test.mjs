import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import worker from "../src/index.js";

const publicRoot = new URL("../public/", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const publicGithubUrl = "https://github.com/Intelligent-Decisions-Interactive/ADBridge";

async function readPublic(relativePath) {
  return readFile(new URL(relativePath, publicRoot), "utf8");
}

async function readSource(relativePath) {
  return readFile(new URL(relativePath, sourceRoot), "utf8");
}

function localAssetPaths(html) {
  return [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith("/") && !value.startsWith("//"))
    .map((value) => value.split(/[?#]/, 1)[0])
    .map((value) => (value.endsWith("/") ? value + "index.html" : value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

test("ADBridge is the homepage flagship and CourierIQ is presented as a private beta", async () => {
  const home = await readPublic("index.html");
  const productStatuses = new Map(
    [...home.matchAll(/<p class="product-status">([^<]+)<\/p>\s*<h3>([^<]+)<\/h3>/g)]
      .map((match) => [match[2], match[1]]),
  );

  assert.match(home, /IDI Studios · Flagship Product/);
  assert.match(home, /<h1>ADBridge<\/h1>/);
  assert.match(home, /Build here\. Run on real Android hardware anywhere\./);
  assert.match(home, /href="\/projects\/adbridge\/"/);
  assert.match(home, /Flagship Product · Developer \+ Enterprise Early Access/);
  assert.match(home, /CourierIQ · Private Beta/);
  assert.match(home, /CourierIQ Private Beta · In-App Overlay/);
  assert.match(home, /CourierIQ Private Beta · Session History/);
  assert.doesNotMatch(home, /Flagship Product · Inside Uber App/);
  assert.doesNotMatch(home, /Flagship Product · Session History/);
  assert.equal(
    productStatuses.get("ADBridge"),
    "Flagship Product · Developer + Enterprise Early Access",
  );
  assert.equal(productStatuses.get("CourierIQ"), "Private Beta · Applications Open");
  assert.equal(productStatuses.get("Chargeback Studio"), "MVP · Pre-Launch");
  assert.equal(productStatuses.get("Revenue Leak Finder"), "MVP · Release Candidate");
  assert.equal(productStatuses.get("BidLens"), "MVP · Pre-Launch");
  assert.equal(productStatuses.get("ScopeFence"), "MVP · Pre-Launch");
  for (const status of productStatuses.values()) assert.doesNotMatch(status, /\blive\b/i);
  assert.match(home, /Preview Chargeback Studio/);
  assert.match(home, /Preview Revenue Leak Finder/);
  assert.match(home, /Preview BidLens/);
  assert.match(home, /Preview ScopeFence/);
});

test("the ADBridge page preserves public product and security boundaries", async () => {
  const page = await readPublic("projects/adbridge/index.html");

  assert.match(page, /ADBridge Developer/);
  assert.match(page, /Free · MIT licensed/);
  assert.match(page, /ADBridge Enterprise/);
  assert.match(page, /Proprietary · Early Access/);
  assert.match(page, /Typed capabilities\. Bounded evidence\. No shell\./);
  assert.match(page, /Enterprise does not bypass Developer policy/);
  assert.match(page, /source-to-device provenance/i);
  assert.match(page, new RegExp(escapeRegExp(publicGithubUrl)));
  assert.doesNotMatch(page, /github\.com\/[^"']*ADBridge-Enterprise/i);
  assert.doesNotMatch(page, /[A-Z]:\\|\/Users\/|\/home\/|100\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  assert.doesNotMatch(page, /private[_ -]?key|certificate thumbprint|bearer value|audit[_ -]?key/i);
});

test("ADBridge is discoverable and every local page asset exists", async () => {
  const [home, page, sitemap] = await Promise.all([
    readPublic("index.html"),
    readPublic("projects/adbridge/index.html"),
    readPublic("sitemap.xml"),
  ]);

  assert.match(sitemap, /https:\/\/intelligentdecisions\.io\/projects\/adbridge\//);

  const paths = new Set([...localAssetPaths(home), ...localAssetPaths(page)]);
  for (const localPath of paths) {
    const fileUrl = new URL("." + localPath, publicRoot);
    await assert.doesNotReject(
      access(fileURLToPath(fileUrl)),
      "Expected local site asset to exist: " + localPath,
    );
  }
});

test("company legal and support pages are complete, discoverable, and locally linked", async () => {
  const pages = await Promise.all([
    readPublic("privacy/index.html"),
    readPublic("terms/index.html"),
    readPublic("support/index.html"),
    readPublic("contact/index.html"),
  ]);
  const sitemap = await readPublic("sitemap.xml");

  for (const path of ["privacy", "terms", "support", "contact"]) {
    assert.match(sitemap, new RegExp(`https:\\/\\/intelligentdecisions\\.io\\/${path}\\/`));
  }
  for (const page of pages) {
    for (const route of ["/privacy/", "/terms/", "/support/", "/contact/"]) {
      assert.match(page, new RegExp(`href="${escapeRegExp(route)}`));
    }
    for (const localPath of localAssetPaths(page)) {
      await assert.doesNotReject(
        access(fileURLToPath(new URL("." + localPath, publicRoot))),
        "Expected legal-page asset to exist: " + localPath,
      );
    }
  }

  const privacy = pages[0];
  assert.match(privacy, /ADBridge/);
  assert.match(privacy, /CourierIQ/);
  assert.match(privacy, /Chargeback Studio/);
  assert.match(privacy, /Revenue Leak Finder/);
  assert.match(privacy, /BidLens/);
  assert.match(privacy, /ScopeFence/);
  assert.match(privacy, /store: false/);
  assert.match(privacy, /abuse-monitoring logs may still retain customer content for up to 30 days/i);
  assert.match(privacy, /controls to delete individual agreements and checks/i);
  assert.match(privacy, /does not delete the shared IDI sign-in/i);
  assert.doesNotMatch(privacy, /zero retention/i);

  const terms = pages[1];
  assert.match(terms, /not provide legal, tax, accounting, financial, compliance, or procurement advice/i);
  assert.match(terms, /You retain ownership/i);
  assert.match(terms, /rights and authority to submit/i);

  const support = pages[2];
  assert.match(support, /do not have a published response-time guarantee/i);
  assert.match(support, /Privacy and deletion/i);
});

test("every active product surface links privacy, terms, support, and contact", async () => {
  const surfaces = await Promise.all([
    readPublic("index.html"),
    readPublic("projects/adbridge/index.html"),
    readPublic("projects/courieriq/index.html"),
    readPublic("projects/chargeback-studio/index.html"),
    readSource("revenue-leak-finder/entry.tsx"),
    readSource("bidlens/entry.tsx"),
    readSource("scopefence/entry.tsx"),
  ]);

  for (const surface of surfaces) {
    for (const route of ["/privacy/", "/terms/", "/support/", "/contact/"]) {
      assert.match(surface, new RegExp(`href=(?:"|\\{?")${escapeRegExp(route)}`));
    }
  }
});

test("the legacy EvidenceLane route permanently redirects to Chargeback Studio", async () => {
  let assetRequests = 0;
  const response = await worker.fetch(
    new Request("https://intelligentdecisions.io/projects/evidencelane/?source=legacy"),
    {
      ASSETS: {
        fetch() {
          assetRequests += 1;
          return new Response("legacy asset should not be served");
        },
      },
    },
  );

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://intelligentdecisions.io/projects/chargeback-studio/?source=legacy",
  );
  assert.equal(assetRequests, 0);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const fallback = await readPublic("projects/evidencelane/index.html");
  assert.doesNotMatch(fallback, /http-equiv=["']refresh/i);
  assert.match(fallback, /href="\/projects\/chargeback-studio\/"/);
});

test("production requests enforce apex HTTPS while local Worker previews stay local", async () => {
  const env = {
    ASSETS: {
      fetch(request) {
        return new Response(new URL(request.url).pathname, {
          headers: { "content-type": "text/plain" },
        });
      },
    },
  };

  const local = await worker.fetch(new Request("http://127.0.0.1:4173/projects/adbridge/"), env);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), "/projects/adbridge/");
  assert.equal(local.headers.get("strict-transport-security"), null);
  assert.match(local.headers.get("content-security-policy") || "", /default-src 'self'/);

  const insecureProduction = await worker.fetch(new Request("http://intelligentdecisions.io/projects/adbridge/"), env);
  assert.equal(insecureProduction.status, 308);
  assert.equal(insecureProduction.headers.get("location"), "https://intelligentdecisions.io/projects/adbridge/");

  const www = await worker.fetch(new Request("https://www.intelligentdecisions.io/projects/adbridge/"), env);
  assert.equal(www.status, 308);
  assert.equal(www.headers.get("location"), "https://intelligentdecisions.io/projects/adbridge/");
});

test("the public health endpoint exposes liveness without integration configuration", async () => {
  const env = {
    ASSETS: { fetch: () => new Response("asset handler should not run") },
    SUPABASE_URL: "configured",
    SUPABASE_SECRET_KEY: "configured",
    STRIPE_SECRET_KEY: "configured",
    OPENAI_API_KEY: "configured",
  };

  const response = await worker.fetch(
    new Request("https://intelligentdecisions.io/api/health"),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, status: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");

  const rejected = await worker.fetch(
    new Request("https://intelligentdecisions.io/api/health", { method: "POST" }),
    env,
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET");
});

test("BidLens and ScopeFence use an existing site icon", async () => {
  for (const pagePath of ["projects/bidlens/index.html", "projects/scopefence/index.html"]) {
    const page = await readPublic(pagePath);
    assert.match(page, /rel="icon" href="\/images\/adbridge-mark\.png"/);
  }

  await assert.doesNotReject(
    access(fileURLToPath(new URL("images/adbridge-mark.png", publicRoot))),
  );
});

test("Chargeback Studio bundles Supabase and receives a least-privilege payment CSP", async () => {
  const page = await readPublic("projects/chargeback-studio/index.html");
  assert.match(page, /<script src="\.\/supabase\.js" defer><\/script>/);
  assert.doesNotMatch(page, /cdn\.jsdelivr\.net/);
  await assert.doesNotReject(
    access(fileURLToPath(new URL("projects/chargeback-studio/supabase.js", publicRoot))),
  );

  const response = await worker.fetch(
    new Request("https://intelligentdecisions.io/projects/chargeback-studio/"),
    { ASSETS: { fetch: () => new Response(page, { headers: { "content-type": "text/html" } }) } },
  );
  const policy = response.headers.get("content-security-policy") || "";

  assert.match(policy, /script-src[^;]*https:\/\/js\.stripe\.com/);
  assert.match(policy, /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/jlbtbpngvqyaiatslphi\.supabase\.co/);
  assert.match(policy, /connect-src[^;]*wss:\/\/jlbtbpngvqyaiatslphi\.supabase\.co/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.stripe\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/cloudflareinsights\.com/);
  assert.match(policy, /frame-src[^;]*https:\/\/hooks\.stripe\.com/);
  assert.match(policy, /img-src[^;]*blob:/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /cdn\.jsdelivr\.net/);
});
