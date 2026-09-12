import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createReportCsv,
  inferMapping,
  parseAmountCents,
  parseCsv,
  reconcile,
  validateMapping,
} from "../src/revenue-leak-finder/reconciliation.ts";
import {
  SAMPLE_LEDGER_CSV,
  SAMPLE_REVENUE_CSV,
} from "../src/revenue-leak-finder/sample-data.ts";

test("parses quoted RFC-style CSV fields and rejects unsafe shapes", () => {
  const parsed = parseCsv('id,email,amount,note\r\n"p,1",a@example.com,"1,299.50","said ""paid"""\r\n');
  assert.equal(parsed.rows[0].id, "p,1");
  assert.equal(parsed.rows[0].amount, "1,299.50");
  assert.equal(parsed.rows[0].note, 'said "paid"');
  assert.equal(parseAmountCents("($1,299.50)"), -129950);
  assert.throws(() => parseCsv("id,id\n1,2"), /unique/);
  assert.throws(() => parseCsv('id,note\n1,"never closed'), /not closed/);
});

test("infers mappings and finds the demo revenue leaks deterministically", () => {
  const revenue = parseCsv(SAMPLE_REVENUE_CSV);
  const ledger = parseCsv(SAMPLE_LEDGER_CSV);
  const revenueMap = inferMapping(revenue.headers);
  const ledgerMap = inferMapping(ledger.headers);
  assert.deepEqual(validateMapping(revenueMap, ledgerMap), []);

  const result = reconcile(revenue, ledger, revenueMap, ledgerMap);
  assert.equal(result.matchedCount, 5);
  assert.equal(result.leftTotalCents, 0);
  assert.equal(result.rightTotalCents, 0);
  assert.deepEqual(result.leftTotalsByCurrency, { USD: 55600, EUR: 19900 });
  assert.deepEqual(result.rightTotalsByCurrency, { USD: 75700 });
  assert.equal(result.sourceRowCoverage, 71);
  const categories = new Set(result.issues.map((issue) => issue.category));
  for (const expected of ["missing_payment", "missing_record", "duplicate", "amount_mismatch", "currency_mismatch", "subscription_mismatch", "unmatched_customer", "total_mismatch"]) {
    assert.ok(categories.has(expected), `expected ${expected}`);
  }
  assert.ok(result.issues.every((issue) => issue.reason && issue.recommendation));
});

test("matches by transaction strong key before weaker conflicting keys", () => {
  const left = parseCsv("transaction_id,invoice_id,email,amount,currency\ntx-1,inv-wrong,same@example.com,10,USD");
  const right = parseCsv("transaction_id,invoice_id,email,amount,currency\ntx-1,inv-right,other@example.com,10,USD\ntx-2,inv-wrong,same@example.com,99,USD");
  const result = reconcile(left, right, inferMapping(left.headers), inferMapping(right.headers));
  assert.equal(result.matchedCount, 1);
  assert.equal(result.issues.find((issue) => issue.leftRow === 2 && issue.rightRow)?.rightRow, undefined);
  assert.ok(result.issues.some((issue) => issue.category === "missing_record" && issue.rightRow === 3));
});

test("counts each exposure once and keeps currencies separate", () => {
  const left = parseCsv("transaction_id,email,amount,currency,status\ntx-1,a@example.com,10,USD,paid\ntx-1,a@example.com,10,USD,paid\ntx-2,b@example.com,20,EUR,paid");
  const right = parseCsv("transaction_id,email,amount,currency,status\ntx-1,a@example.com,5,USD,failed\ntx-2,b@example.com,10,EUR,paid");
  const result = reconcile(left, right, inferMapping(left.headers), inferMapping(right.headers));
  assert.deepEqual(result.currencies, ["EUR", "USD"]);
  assert.equal(result.valueAtRiskCents, 0);
  assert.equal(result.valueAtRiskByCurrency.USD, 2000);
  assert.equal(result.valueAtRiskByCurrency.EUR, 1000);
  assert.equal(result.leftTotalCents, 0);
  assert.equal(result.rightTotalCents, 0);
});

test("creates a downloadable report and neutralizes spreadsheet formulas", () => {
  const left = parseCsv("payment_id,email,amount,status\npay_1,=IMPORTXML(evil),12.00,paid");
  const right = parseCsv("transaction_id,email,total,payment_status\npay_2,safe@example.com,12.00,paid");
  const result = reconcile(left, right, inferMapping(left.headers), inferMapping(right.headers));
  const report = createReportCsv(result);
  assert.match(report, /Why flagged,Recommended action/);
  assert.match(report, /'=IMPORTXML/);
  assert.doesNotMatch(report, /,=IMPORTXML/);
});

test("ships the product flow, private aggregate history, and paid credit gate", async () => {
  const [page, client, worker, migration, webhook, auth, checkout] = await Promise.all([
    readFile(new URL("../public/projects/revenue-leak-finder/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/revenue-leak-finder/revenue-leak-finder.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260910195703_revenue_leak_finder.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../src/revenue-leak-api.js", import.meta.url), "utf8"),
    readFile(new URL("../src/revenue-leak-api.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Revenue Leak Finder/);
  assert.match(client, /Files stay in your browser/);
  assert.match(client, /SAMPLE_REVENUE_CSV/);
  assert.match(client, /Download report/);
  assert.match(client, /Buy 10 reports · \$29/);
  assert.match(client, /Raw CSV rows never leave this browser/);
  assert.match(worker, /\/api\/revenue-leak-finder\//);
  assert.match(worker, /revenue-leak-finder/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Strict/);
  assert.match(auth, /Path=\$\{COOKIE_PATH\}/);
  assert.match(checkout, /automatic_tax\[enabled\]/);
  assert.match(checkout, /checkout\.stripe\.com/);
  assert.match(webhook, /checkout\.session\.completed/);
  assert.match(webhook, /fulfillRevenueLeakStripeEvent/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.revenue_leak_accounts from public, anon, authenticated/);
  assert.match(migration, /revenue_leak_record_analysis/);
  assert.match(migration, /revenue_leak_fulfill_purchase/);
  assert.match(migration, /Raw CSV rows and customer PII are never stored/);
  assert.doesNotMatch(migration, /create policy/);
});
