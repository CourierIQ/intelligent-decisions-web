import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import worker from "../src/index.js";

const publicRoot = new URL("../public/", import.meta.url);
const publicGithubUrl = "https://github.com/Intelligent-Decisions-Interactive/ADBridge";

async function readPublic(relativePath) {
  return readFile(new URL(relativePath, publicRoot), "utf8");
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
  assert.match(policy, /connect-src[^;]*https:\/\/jlbtbpngvqyaiatslphi\.supabase\.co/);
  assert.match(policy, /connect-src[^;]*wss:\/\/jlbtbpngvqyaiatslphi\.supabase\.co/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.stripe\.com/);
  assert.match(policy, /frame-src[^;]*https:\/\/hooks\.stripe\.com/);
  assert.match(policy, /img-src[^;]*blob:/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /cdn\.jsdelivr\.net/);
});
