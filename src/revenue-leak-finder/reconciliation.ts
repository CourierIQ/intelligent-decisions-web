export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 25_000;
export const MAX_COLUMNS = 100;

export type CsvTable = {
  headers: string[];
  rows: Record<string, string>[];
};

export type SemanticField =
  | "transactionId"
  | "invoiceId"
  | "customerId"
  | "email"
  | "amount"
  | "currency"
  | "status"
  | "subscriptionStatus"
  | "date";

export type ColumnMapping = Partial<Record<SemanticField, string>>;

export type LeakCategory =
  | "missing_payment"
  | "missing_record"
  | "amount_mismatch"
  | "currency_mismatch"
  | "status_mismatch"
  | "subscription_mismatch"
  | "duplicate"
  | "unmatched_customer"
  | "total_mismatch";

export type LeakIssue = {
  id: string;
  category: LeakCategory;
  severity: "high" | "medium" | "low";
  source: "left" | "right" | "both";
  reference: string;
  customer: string;
  amountCents: number;
  currency: string;
  exposureKey: string;
  reason: string;
  recommendation: string;
  leftRow?: number;
  rightRow?: number;
};

export type ReconciliationResult = {
  issues: LeakIssue[];
  matchedCount: number;
  leftCount: number;
  rightCount: number;
  leftTotalCents: number;
  rightTotalCents: number;
  valueAtRiskCents: number;
  sourceRowCoverage: number;
  currencies: string[];
  leftTotalsByCurrency: Record<string, number>;
  rightTotalsByCurrency: Record<string, number>;
  valueAtRiskByCurrency: Record<string, number>;
  issueCounts: Record<LeakCategory, number>;
};

const FIELD_ALIASES: Record<SemanticField, string[]> = {
  transactionId: ["transactionid", "transaction_id", "paymentid", "payment_id", "chargeid", "charge_id", "id"],
  invoiceId: ["invoiceid", "invoice_id", "invoice", "orderid", "order_id", "order"],
  customerId: ["customerid", "customer_id", "clientid", "client_id", "accountid", "account_id"],
  email: ["email", "customeremail", "customer_email", "billingemail", "billing_email"],
  amount: ["amount", "total", "gross", "paidamount", "paid_amount", "amountpaid", "amount_paid", "revenue"],
  currency: ["currency", "currencycode", "currency_code"],
  status: ["status", "paymentstatus", "payment_status", "state"],
  subscriptionStatus: ["subscriptionstatus", "subscription_status", "planstatus", "plan_status", "membershipstatus"],
  date: ["date", "created", "createdat", "created_at", "paidat", "paid_at", "transactiondate", "transaction_date"],
};

const PAID_STATUSES = new Set(["paid", "succeeded", "successful", "complete", "completed", "settled", "active", "current"]);
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled", "void", "refunded", "unpaid", "past_due", "past due"]);

function normalizedHeader(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function normalizedValue(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
}

export function parseCsv(input: string): CsvTable {
  if (input.includes("\0")) throw new Error("This file contains unsupported binary data.");
  const source = input.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length) throw new Error(`Unexpected quote near row ${matrix.length + 1}.`);
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim())) matrix.push(row);
      row = [];
      if (matrix.length > MAX_ROWS + 1) throw new Error(`CSV files are limited to ${MAX_ROWS.toLocaleString()} data rows.`);
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("A quoted field is not closed.");
  row.push(cell);
  if (row.some((value) => value.trim())) matrix.push(row);
  if (matrix.length < 2) throw new Error("Include a header row and at least one data row.");

  const headers = matrix[0].map((header) => header.normalize("NFKC").trim());
  if (headers.length > MAX_COLUMNS) throw new Error(`CSV files are limited to ${MAX_COLUMNS} columns.`);
  if (headers.some((header) => !header)) throw new Error("Every column needs a header.");
  const normalizedHeaders = headers.map(normalizedHeader);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new Error("Column headers must be unique.");
  }
  const rows = matrix.slice(1).map((values) => {
    if (values.length > headers.length) throw new Error("A data row has more columns than the header row.");
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()]));
  });
  return { headers, rows };
}

export function inferMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const available = headers.map((header) => ({ header, normalized: normalizedHeader(header) }));
  for (const field of Object.keys(FIELD_ALIASES) as SemanticField[]) {
    const aliases = FIELD_ALIASES[field];
    const exact = available.find(({ normalized }) => aliases.includes(normalized));
    if (exact) mapping[field] = exact.header;
  }
  return mapping;
}

export function validateMapping(left: ColumnMapping, right: ColumnMapping) {
  const errors: string[] = [];
  if (!left.amount || !right.amount) errors.push("Map an amount column in both files.");
  const hasSharedIdentity = (["transactionId", "invoiceId", "customerId", "email"] as SemanticField[])
    .some((field) => Boolean(left[field] && right[field]));
  if (!hasSharedIdentity) errors.push("Map at least one shared transaction, invoice, customer, or email field.");
  return errors;
}

function field(row: Record<string, string>, mapping: ColumnMapping, key: SemanticField) {
  const column = mapping[key];
  return column ? row[column] || "" : "";
}

export function parseAmountCents(value: string) {
  const raw = value.normalize("NFKC").trim();
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith("-");
  const cleaned = raw.replace(/[()$£€¥,\s]/g, "").replace(/^[+-]/, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  const [whole, decimal = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  return negative ? -cents : cents;
}

function normalizedStatus(value: string) {
  const status = normalizedValue(value).replace(/[-\s]+/g, "_");
  if (PAID_STATUSES.has(status)) return "paid";
  if (FAILED_STATUSES.has(status) || FAILED_STATUSES.has(status.replace(/_/g, " "))) return "failed";
  return status;
}

function paidLike(row: Record<string, string>, mapping: ColumnMapping) {
  const value = field(row, mapping, "status");
  return !value || normalizedStatus(value) === "paid";
}

function identityKeys(row: Record<string, string>, mapping: ColumnMapping) {
  return (["transactionId", "invoiceId", "customerId", "email"] as SemanticField[])
    .map((key) => {
      const value = normalizedValue(field(row, mapping, key));
      return value ? `${key}:${value}` : "";
    })
    .filter(Boolean);
}

function customerIdentityKeys(row: Record<string, string>, mapping: ColumnMapping) {
  return (["customerId", "email"] as SemanticField[])
    .map((key) => {
      const value = normalizedValue(field(row, mapping, key));
      return value ? `${key}:${value}` : "";
    })
    .filter(Boolean);
}

function reference(row: Record<string, string>, mapping: ColumnMapping, fallback: number) {
  return field(row, mapping, "transactionId") || field(row, mapping, "invoiceId") || `Row ${fallback}`;
}

function customer(row: Record<string, string>, mapping: ColumnMapping) {
  return field(row, mapping, "email") || field(row, mapping, "customerId") || "Unknown customer";
}

function rowCurrency(row: Record<string, string>, mapping: ColumnMapping) {
  if (!mapping.currency) return "USD";
  const value = normalizedValue(field(row, mapping, "currency")).toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : "UNSPECIFIED";
}

function issueId(category: LeakCategory, source: string, leftRow?: number, rightRow?: number) {
  return `${category}:${source}:${leftRow || 0}:${rightRow || 0}`;
}

function emptyCounts(): Record<LeakCategory, number> {
  return {
    missing_payment: 0,
    missing_record: 0,
    amount_mismatch: 0,
    currency_mismatch: 0,
    status_mismatch: 0,
    subscription_mismatch: 0,
    duplicate: 0,
    unmatched_customer: 0,
    total_mismatch: 0,
  };
}

function bestCandidate(
  leftRow: Record<string, string>,
  leftMap: ColumnMapping,
  candidates: number[],
  rightRows: Record<string, string>[],
  rightMap: ColumnMapping,
) {
  const leftAmount = parseAmountCents(field(leftRow, leftMap, "amount"));
  const leftDate = Date.parse(field(leftRow, leftMap, "date"));
  return [...candidates].sort((a, b) => {
    const score = (index: number) => {
      const amount = parseAmountCents(field(rightRows[index], rightMap, "amount"));
      const date = Date.parse(field(rightRows[index], rightMap, "date"));
      const amountDistance = Number.isFinite(leftAmount) && Number.isFinite(amount) ? Math.abs(leftAmount - amount) : 1_000_000_000;
      const dateDistance = Number.isFinite(leftDate) && Number.isFinite(date) ? Math.abs(leftDate - date) / 86_400_000 : 10_000;
      return amountDistance * 100 + Math.min(dateDistance, 10_000);
    };
    return score(a) - score(b) || a - b;
  })[0];
}

export function reconcile(
  left: CsvTable,
  right: CsvTable,
  leftMap: ColumnMapping,
  rightMap: ColumnMapping,
): ReconciliationResult {
  const validation = validateMapping(leftMap, rightMap);
  if (validation.length) throw new Error(validation.join(" "));
  const issues: LeakIssue[] = [];
  const rightIndexesByKey = new Map<string, number[]>();
  const leftIdentitySet = new Set(left.rows.flatMap((row) => identityKeys(row, leftMap)));
  right.rows.forEach((row, index) => {
    for (const key of identityKeys(row, rightMap)) {
      rightIndexesByKey.set(key, [...(rightIndexesByKey.get(key) || []), index]);
    }
  });

  const addDuplicates = (table: CsvTable, mapping: ColumnMapping, source: "left" | "right") => {
    const seen = new Map<string, number>();
    table.rows.forEach((row, index) => {
      const primary = identityKeys(row, mapping)[0];
      if (!primary) return;
      const first = seen.get(primary);
      if (first === undefined) {
        seen.set(primary, index);
        return;
      }
      const amount = parseAmountCents(field(row, mapping, "amount"));
      issues.push({
        id: issueId("duplicate", source, source === "left" ? index + 2 : undefined, source === "right" ? index + 2 : undefined),
        category: "duplicate",
        severity: "high",
        source,
        reference: reference(row, mapping, index + 2),
        customer: customer(row, mapping),
        amountCents: Number.isFinite(amount) ? Math.abs(amount) : 0,
        currency: rowCurrency(row, mapping),
        exposureKey: `${source}:${index}`,
        reason: `${source === "left" ? "Revenue source" : "Ledger"} rows ${first + 2} and ${index + 2} share ${primary.split(":", 1)[0]} “${primary.slice(primary.indexOf(":") + 1)}”.`,
        recommendation: "Confirm whether this is a retry, duplicate import, or a second legitimate charge before posting revenue.",
        ...(source === "left" ? { leftRow: index + 2 } : { rightRow: index + 2 }),
      });
    });
  };
  addDuplicates(left, leftMap, "left");
  addDuplicates(right, rightMap, "right");

  const matchedRight = new Set<number>();
  let matchedCount = 0;
  left.rows.forEach((leftRow, leftIndex) => {
    let candidates: number[] = [];
    for (const identity of ["transactionId", "invoiceId", "customerId", "email"] as SemanticField[]) {
      const value = normalizedValue(field(leftRow, leftMap, identity));
      if (!value || !rightMap[identity]) continue;
      const available = (rightIndexesByKey.get(`${identity}:${value}`) || [])
        .filter((index) => !matchedRight.has(index));
      if (available.length) {
        candidates = available;
        break;
      }
    }
    if (!candidates.length) {
      const amount = parseAmountCents(field(leftRow, leftMap, "amount"));
      const isPaid = paidLike(leftRow, leftMap);
      issues.push({
        id: issueId(isPaid ? "missing_payment" : "unmatched_customer", "left", leftIndex + 2),
        category: isPaid ? "missing_payment" : "unmatched_customer",
        severity: isPaid ? "high" : "medium",
        source: "left",
        reference: reference(leftRow, leftMap, leftIndex + 2),
        customer: customer(leftRow, leftMap),
        amountCents: Number.isFinite(amount) && isPaid ? Math.abs(amount) : 0,
        currency: rowCurrency(leftRow, leftMap),
        exposureKey: `left:${leftIndex}`,
        reason: isPaid
          ? "A successful revenue-source record has no transaction, invoice, customer, or email match in the ledger."
          : "This source record has no matching customer identity in the ledger.",
        recommendation: isPaid
          ? "Verify settlement, then create or repair the missing accounting/CRM record."
          : "Confirm the customer identifiers or exclude failed/void activity from reconciliation.",
        leftRow: leftIndex + 2,
      });
      const leftCustomerKeys = customerIdentityKeys(leftRow, leftMap);
      const hasUnmatchedCustomer = isPaid && leftCustomerKeys.length > 0 && leftCustomerKeys.every((key) => !rightIndexesByKey.has(key));
      if (hasUnmatchedCustomer) {
        issues.push({
          id: issueId("unmatched_customer", "left", leftIndex + 2),
          category: "unmatched_customer",
          severity: "medium",
          source: "left",
          reference: reference(leftRow, leftMap, leftIndex + 2),
          customer: customer(leftRow, leftMap),
          amountCents: 0,
          currency: rowCurrency(leftRow, leftMap),
          exposureKey: `left:${leftIndex}`,
          reason: "The customer ID or email in this revenue record does not appear anywhere in the ledger export.",
          recommendation: "Check for an outdated email, merged CRM account, or missing customer sync before creating a duplicate customer.",
          leftRow: leftIndex + 2,
        });
      }
      return;
    }
    const rightIndex = bestCandidate(leftRow, leftMap, candidates, right.rows, rightMap);
    const rightRow = right.rows[rightIndex];
    matchedRight.add(rightIndex);
    matchedCount += 1;
    const leftAmount = parseAmountCents(field(leftRow, leftMap, "amount"));
    const rightAmount = parseAmountCents(field(rightRow, rightMap, "amount"));
    const base = {
      source: "both" as const,
      reference: reference(leftRow, leftMap, leftIndex + 2),
      customer: customer(leftRow, leftMap) || customer(rightRow, rightMap),
      leftRow: leftIndex + 2,
      rightRow: rightIndex + 2,
      currency: rowCurrency(leftRow, leftMap),
      exposureKey: `match:${leftIndex}:${rightIndex}`,
    };
    if (!Number.isFinite(leftAmount) || !Number.isFinite(rightAmount)) {
      issues.push({
        ...base,
        id: issueId("amount_mismatch", "both", leftIndex + 2, rightIndex + 2),
        category: "amount_mismatch",
        severity: "high",
        amountCents: 0,
        reason: "At least one matched amount is not a recognized monetary value.",
        recommendation: "Correct the amount format, then rerun the reconciliation.",
      });
    } else if (Math.abs(leftAmount - rightAmount) > 1) {
      issues.push({
        ...base,
        id: issueId("amount_mismatch", "both", leftIndex + 2, rightIndex + 2),
        category: "amount_mismatch",
        severity: "high",
        amountCents: Math.abs(leftAmount - rightAmount),
        reason: `Revenue source shows ${formatMoney(leftAmount)} while the ledger shows ${formatMoney(rightAmount)}.`,
        recommendation: "Check fees, partial payments, refunds, and tax treatment; correct the system that holds the wrong gross amount.",
      });
    }
    const leftCurrency = normalizedValue(field(leftRow, leftMap, "currency"));
    const rightCurrency = normalizedValue(field(rightRow, rightMap, "currency"));
    if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) {
      issues.push({
        ...base,
        id: issueId("currency_mismatch", "both", leftIndex + 2, rightIndex + 2),
        category: "currency_mismatch",
        severity: "high",
        amountCents: Number.isFinite(leftAmount) ? Math.abs(leftAmount) : 0,
        reason: `Currency differs: ${leftCurrency.toUpperCase()} in the revenue source and ${rightCurrency.toUpperCase()} in the ledger.`,
        recommendation: "Confirm the settlement currency and whether an FX conversion entry is missing.",
      });
    }
    const leftStatus = normalizedStatus(field(leftRow, leftMap, "status"));
    const rightStatus = normalizedStatus(field(rightRow, rightMap, "status"));
    if (leftStatus && rightStatus && leftStatus !== rightStatus) {
      issues.push({
        ...base,
        id: issueId("status_mismatch", "both", leftIndex + 2, rightIndex + 2),
        category: "status_mismatch",
        severity: leftStatus === "paid" || rightStatus === "paid" ? "high" : "medium",
        amountCents: Number.isFinite(leftAmount) ? Math.abs(leftAmount) : 0,
        reason: `Payment status differs: “${field(leftRow, leftMap, "status") || "blank"}” versus “${field(rightRow, rightMap, "status") || "blank"}”.`,
        recommendation: "Verify the latest processor event and repair the stale status or webhook/import path.",
      });
    }
    const normalizeSubscription = (value: string) => normalizedValue(value).replace(/[-\s]+/g, "_").replace(/^cancelled$/, "canceled");
    const leftSubscription = normalizeSubscription(field(leftRow, leftMap, "subscriptionStatus"));
    const rightSubscription = normalizeSubscription(field(rightRow, rightMap, "subscriptionStatus"));
    if (leftSubscription && rightSubscription && leftSubscription !== rightSubscription) {
      issues.push({
        ...base,
        id: issueId("subscription_mismatch", "both", leftIndex + 2, rightIndex + 2),
        category: "subscription_mismatch",
        severity: "medium",
        amountCents: Number.isFinite(leftAmount) ? Math.abs(leftAmount) : 0,
        reason: `Subscription state differs: “${leftSubscription}” versus “${rightSubscription}”.`,
        recommendation: "Check cancellation, renewal, and dunning events, then sync the customer lifecycle state.",
      });
    }
  });

  right.rows.forEach((rightRow, rightIndex) => {
    if (matchedRight.has(rightIndex)) return;
    const amount = parseAmountCents(field(rightRow, rightMap, "amount"));
    const isPaid = paidLike(rightRow, rightMap);
    issues.push({
      id: issueId(isPaid ? "missing_record" : "unmatched_customer", "right", undefined, rightIndex + 2),
      category: isPaid ? "missing_record" : "unmatched_customer",
      severity: isPaid ? "high" : "low",
      source: "right",
      reference: reference(rightRow, rightMap, rightIndex + 2),
      customer: customer(rightRow, rightMap),
      amountCents: Number.isFinite(amount) && isPaid ? Math.abs(amount) : 0,
      currency: rowCurrency(rightRow, rightMap),
      exposureKey: `right:${rightIndex}`,
      reason: isPaid
        ? "A paid ledger/CRM record has no matching transaction in the revenue source."
        : "This ledger record has no matching customer identity in the revenue source.",
      recommendation: isPaid
        ? "Confirm that the payment exists and was not manually marked paid; investigate migration or processor routing gaps."
        : "Confirm the customer identifiers or remove stale failed/void records from the comparison.",
      rightRow: rightIndex + 2,
    });
    const rightCustomerKeys = customerIdentityKeys(rightRow, rightMap);
    const hasUnmatchedCustomer = isPaid && rightCustomerKeys.length > 0 && rightCustomerKeys.every((key) => !leftIdentitySet.has(key));
    if (hasUnmatchedCustomer) {
      issues.push({
        id: issueId("unmatched_customer", "right", undefined, rightIndex + 2),
        category: "unmatched_customer",
        severity: "medium",
        source: "right",
        reference: reference(rightRow, rightMap, rightIndex + 2),
        customer: customer(rightRow, rightMap),
        amountCents: 0,
        currency: rowCurrency(rightRow, rightMap),
        exposureKey: `right:${rightIndex}`,
        reason: "The customer ID or email in this ledger record does not appear anywhere in the revenue export.",
        recommendation: "Verify whether the ledger record was entered manually or the customer was migrated under another identity.",
        rightRow: rightIndex + 2,
      });
    }
  });

  const sumPaidByCurrency = (table: CsvTable, mapping: ColumnMapping) => table.rows.reduce<Record<string, number>>((totals, row) => {
    const amount = parseAmountCents(field(row, mapping, "amount"));
    if (paidLike(row, mapping) && Number.isFinite(amount)) {
      const currency = rowCurrency(row, mapping);
      totals[currency] = (totals[currency] || 0) + amount;
    }
    return totals;
  }, {});
  const leftTotalsByCurrency = sumPaidByCurrency(left, leftMap);
  const rightTotalsByCurrency = sumPaidByCurrency(right, rightMap);
  const currencies = [...new Set([...Object.keys(leftTotalsByCurrency), ...Object.keys(rightTotalsByCurrency)])].sort();
  for (const currency of currencies) {
    const totalDifference = Math.abs((leftTotalsByCurrency[currency] || 0) - (rightTotalsByCurrency[currency] || 0));
    if (totalDifference <= 1) continue;
    issues.push({
      id: `${issueId("total_mismatch", "both")}:${currency}`,
      category: "total_mismatch",
      severity: "high",
      source: "both",
      reference: `${currency} reconciled totals`,
      customer: "All customers",
      amountCents: totalDifference,
      currency,
      exposureKey: `total:${currency}`,
      reason: `${currency} paid totals differ by ${formatMoney(totalDifference, currency)} across the two exports.`,
      recommendation: "Resolve the row-level exceptions, then confirm both exports use the same date range, timezone, currency, and gross/net convention.",
    });
  }

  issues.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.severity] - rank[b.severity] || b.amountCents - a.amountCents || a.id.localeCompare(b.id);
  });
  const issueCounts = emptyCounts();
  issues.forEach((issue) => { issueCounts[issue.category] += 1; });
  const sourceRowCoverage = Math.round(matchedCount / Math.max(1, left.rows.length) * 100);
  const exposureRisk = new Map<string, { currency: string; amountCents: number }>();
  for (const issue of issues) {
    if (issue.severity !== "high" || issue.category === "total_mismatch" || issue.amountCents <= 0) continue;
    const current = exposureRisk.get(issue.exposureKey);
    if (!current || issue.amountCents > current.amountCents) {
      exposureRisk.set(issue.exposureKey, { currency: issue.currency, amountCents: issue.amountCents });
    }
  }
  const valueAtRiskByCurrency: Record<string, number> = {};
  for (const risk of exposureRisk.values()) {
    valueAtRiskByCurrency[risk.currency] = (valueAtRiskByCurrency[risk.currency] || 0) + risk.amountCents;
  }
  const singleCurrency = currencies.length === 1 ? currencies[0] : "";
  const leftTotalCents = singleCurrency ? leftTotalsByCurrency[singleCurrency] || 0 : 0;
  const rightTotalCents = singleCurrency ? rightTotalsByCurrency[singleCurrency] || 0 : 0;
  const valueAtRiskCents = singleCurrency ? valueAtRiskByCurrency[singleCurrency] || 0 : 0;
  return {
    issues,
    matchedCount,
    leftCount: left.rows.length,
    rightCount: right.rows.length,
    leftTotalCents,
    rightTotalCents,
    valueAtRiskCents,
    sourceRowCoverage,
    currencies,
    leftTotalsByCurrency,
    rightTotalsByCurrency,
    valueAtRiskByCurrency,
    issueCounts,
  };
}

export function formatMoney(cents: number, currency = "USD") {
  if (!/^[A-Z]{3}$/.test(currency)) return `${(cents / 100).toFixed(2)} ${currency}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createReportCsv(result: ReconciliationResult) {
  const headers = ["Severity", "Category", "Reference", "Customer", "Value at risk", "Source row", "Ledger row", "Why flagged", "Recommended action"];
  const rows = result.issues.map((issue) => [
    issue.severity,
    issue.category.replace(/_/g, " "),
    issue.reference,
    issue.customer,
    formatMoney(issue.amountCents, issue.currency),
    issue.leftRow || "",
    issue.rightRow || "",
    issue.reason,
    issue.recommendation,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
