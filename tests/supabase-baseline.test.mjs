import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const expectedProductionMigrations = [
  "20260711_add_google_play_email.sql",
  "20260909184026_evidencelane_stripe_orders.sql",
  "20260909185604_enable_courieriq_rls.sql",
  "20260909193138_add_evidencelane_pack_tiers.sql",
  "20260909212247_chargeback_studio_workspace.sql",
  "20260909214112_protect_chargeback_pack_entitlements.sql",
  "20260909214724_chargeback_studio_foreign_key_indexes.sql",
  "20260910045155_add_chargeback_payment_intents.sql",
  "20260910045408_protect_chargeback_payment_intent_insert.sql",
  "20260910213606_revenue_leak_finder.sql",
  "20260910213644_harden_revenue_leak_finder.sql",
  "20260911174033_scope_chargeback_user_provisioning.sql",
  "20260912061857_bidlens_mvp.sql",
  "20260912061911_scopefence_mvp.sql",
  "20260912062004_bidlens_scopefence_foreign_key_indexes.sql",
  "20260913013045_release_database_hardening.sql",
  "20260913013100_scopefence_customer_data_deletion.sql",
];

const expectedLegacyTables = [
  "beta_access_request_events",
  "beta_access_requests",
  "courieriq_active_trips",
  "courieriq_auth_accounts",
  "courieriq_auth_email_identities",
  "courieriq_oauth_states",
  "courieriq_offer_score_components",
  "courieriq_offers",
  "courieriq_payment_purchases",
  "courieriq_sessions",
  "courieriq_sync_batches",
  "courieriq_sync_records",
  "courieriq_trips",
  "courieriq_users",
];

test("tracks every migration version currently recorded in production", async () => {
  const files = await readdir(new URL("../supabase/migrations/", import.meta.url));

  for (const migration of expectedProductionMigrations) {
    assert.ok(files.includes(migration), `missing production migration ${migration}`);
  }
});

test("captures the complete legacy CourierIQ and beta schema inventory", async () => {
  const baseline = await readFile(
    new URL(
      "../supabase/migrations/20260711_add_google_play_email.sql",
      import.meta.url,
    ),
    "utf8",
  );

  const tableNames = [...baseline.matchAll(
    /create table if not exists public\.(\w+)/g,
  )].map((match) => match[1]).sort();
  const constraintNames = [...baseline.matchAll(
    /\bconstraint\s+([a-z][a-z0-9_]*)/gi,
  )].map((match) => match[1]).filter((name) => name !== "pg_constraint");
  const indexNames = [...baseline.matchAll(
    /create (?:unique )?index if not exists ([a-z][a-z0-9_]*)/gi,
  )].map((match) => match[1]);

  let columnCount = 0;
  for (const table of baseline.matchAll(
    /create table if not exists public\.(\w+) \(([\s\S]*?)\r?\n\);/g,
  )) {
    columnCount += table[2].split(/\r?\n/).filter((line) => {
      const match = line.match(/^ {4}([a-z][a-z0-9_]*)\s/);
      return match && match[1] !== "constraint";
    }).length;
  }
  columnCount += 1; // google_play_email is added by the original migration body.

  assert.deepEqual(tableNames, expectedLegacyTables);
  assert.equal(columnCount, 209);
  assert.equal(constraintNames.length, 40);
  assert.equal(new Set(constraintNames).size, 40);
  assert.equal(indexNames.length, 32);
  assert.equal(new Set(indexNames).size, 32);
});

test("keeps release hardening forward-only and idempotent", async () => {
  const hardening = await readFile(
    new URL(
      "../supabase/migrations/20260913013045_release_database_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(hardening, /grant select, update\s+on table public\.chargeback_packs/i);
  assert.match(
    hardening,
    /create index if not exists idx_courieriq_offer_score_components_offer_id/i,
  );
  assert.match(
    hardening,
    /create index if not exists idx_courieriq_offer_score_components_user_id/i,
  );
});
