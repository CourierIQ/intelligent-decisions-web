import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handleScopeFenceApi, scopeFenceInternals } from "../src/scopefence-api.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "owner@example.com";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};

function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Origin")) headers.set("Origin", "https://intelligentdecisions.io");
  headers.set("Cookie", "idi_scopefence_access=test-access-token");
  return new Request(`https://intelligentdecisions.io${path}`, { ...options, headers });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockFetch(responder, action) {
  const original = globalThis.fetch;
  globalThis.fetch = responder;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

function authenticatedResponder(calls, restResponse) {
  return async (resource, options = {}) => {
    const url = new URL(String(resource));
    calls.push({ url, options });
    if (url.pathname === "/auth/v1/user") return json({ id: USER_ID, email: EMAIL });
    return typeof restResponse === "function" ? restResponse(url, options) : restResponse;
  };
}

test("ScopeFence deletion paths accept only exact UUID resources", () => {
  assert.equal(scopeFenceInternals.ownedResourceId(`/api/scopefence/scopes/${RESOURCE_ID}`, "scopes"), RESOURCE_ID);
  assert.equal(scopeFenceInternals.ownedResourceId(`/api/scopefence/analyses/${RESOURCE_ID}`, "analyses"), RESOURCE_ID);
  assert.equal(scopeFenceInternals.ownedResourceId("/api/scopefence/scopes/not-a-uuid", "scopes"), null);
  assert.equal(scopeFenceInternals.ownedResourceId(`/api/scopefence/scopes/${RESOURCE_ID}/extra`, "scopes"), null);
});

test("saved agreement deletion is authenticated and constrained to the owner", async () => {
  const calls = [];
  const response = await withMockFetch(
    authenticatedResponder(calls, (url, options) => {
      assert.equal(url.pathname, "/rest/v1/scopefence_scopes");
      assert.equal(url.searchParams.get("id"), `eq.${RESOURCE_ID}`);
      assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
      return json([{ id: RESOURCE_ID }]);
    }),
    async () => {
      const request = apiRequest(`/api/scopefence/scopes/${RESOURCE_ID}`, { method: "DELETE" });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deletedId: RESOURCE_ID });
  assert.equal(calls.length, 2);
});

test("saved check deletion does not reveal or delete another owner's record", async () => {
  const calls = [];
  const response = await withMockFetch(
    authenticatedResponder(calls, (url, options) => {
      assert.equal(url.pathname, "/rest/v1/scopefence_analyses");
      assert.equal(url.searchParams.get("id"), `eq.${RESOURCE_ID}`);
      assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
      assert.equal(options.method, "DELETE");
      return json([]);
    }),
    async () => {
      const request = apiRequest(`/api/scopefence/analyses/${RESOURCE_ID}`, { method: "DELETE" });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "That saved check was not found." });
  assert.equal(calls.length, 2);
});

test("clearing history deletes only the authenticated user's saved analyses", async () => {
  const calls = [];
  const response = await withMockFetch(
    authenticatedResponder(calls, (url, options) => {
      assert.equal(url.pathname, "/rest/v1/scopefence_analyses");
      assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
      assert.equal(options.method, "DELETE");
      return json([{ id: RESOURCE_ID }, { id: "33333333-3333-4333-8333-333333333333" }]);
    }),
    async () => {
      const request = apiRequest("/api/scopefence/history", { method: "DELETE" });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deletedCount: 2 });
});

test("workspace deletion requires the account email and expires the ScopeFence session", async () => {
  const rejectedCalls = [];
  const rejected = await withMockFetch(
    authenticatedResponder(rejectedCalls, json([])),
    async () => {
      const request = apiRequest("/api/scopefence/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "wrong@example.com" }),
      });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejectedCalls.length, 1);

  const calls = [];
  const response = await withMockFetch(
    authenticatedResponder(calls, (url, options) => {
      if (url.pathname === "/rest/v1/scopefence_accounts") {
        assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
        assert.equal(options.method, "DELETE");
        return json([{ user_id: USER_ID }]);
      }
      if (url.pathname === "/auth/v1/logout") {
        assert.equal(url.searchParams.get("scope"), "local");
        return json({});
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
    async () => {
      const request = apiRequest("/api/scopefence/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: EMAIL.toUpperCase() }),
      });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie") || "", /idi_scopefence_access=.*Max-Age=0/);
  assert.match(response.headers.get("set-cookie") || "", /idi_scopefence_refresh=.*Max-Age=0/);
  assert.equal(calls.length, 3);
});

test("cross-origin deletion is rejected before authentication or storage access", async () => {
  let calls = 0;
  const response = await withMockFetch(
    async () => { calls += 1; return json({}); },
    async () => {
      const request = apiRequest(`/api/scopefence/scopes/${RESOURCE_ID}`, {
        method: "DELETE",
        headers: { Origin: "https://attacker.example" },
      });
      return handleScopeFenceApi(request, env, new URL(request.url));
    },
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("the deletion migration preserves payment audit without reviving deleted workspaces", async () => {
  const [migration, api, ui] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260913011022_scopefence_customer_data_deletion.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/scopefence-api.js", import.meta.url), "utf8"),
    readFile(new URL("../src/scopefence/workspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /alter column user_id drop not null/i);
  assert.match(migration, /on delete set null/i);
  assert.match(migration, /insert into public\.scopefence_credit_orders[\s\S]*select[\s\S]*from public\.scopefence_accounts/i);
  assert.doesNotMatch(migration, /insert into public\.scopefence_accounts/i);
  assert.match(migration, /revoke all on function public\.scopefence_fulfill_credit_purchase/i);
  assert.match(migration, /grant execute on function public\.scopefence_fulfill_credit_purchase[\s\S]*to service_role/i);
  assert.doesNotMatch(api, /deleteUser|admin\/users/);
  for (const route of ["scopes", "analyses", "history", "account"]) assert.match(ui, new RegExp(`/api/scopefence/${route}`));
  assert.match(ui, /Your shared IDI sign-in and data in other IDI products are not deleted/);
});
