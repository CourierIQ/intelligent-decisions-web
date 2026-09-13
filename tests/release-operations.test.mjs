import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedBindings = [
  "ASSETS",
  "BETA_INVITE_URL",
  "BIDLENS_OPENAI_MODEL",
  "BIDLENS_STRIPE_WEBHOOK_SECRET",
  "CHARGEBACK_STUDIO_URL",
  "EVIDENCELANE_ORIGIN",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "RESEND_API_KEY",
  "SCOPEFENCE_OPENAI_MODEL",
  "SCOPEFENCE_STRIPE_WEBHOOK_SECRET",
  "STRIPE_CHARGEBACK_TAX_CODE",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_URL",
  "TURNSTILE_SECRET_KEY",
].sort();

const sourcePaths = [
  "../src/index.js",
  "../src/product-platform.js",
  "../src/revenue-leak-api.js",
  "../src/bidlens-api.js",
  "../src/scopefence-api.js",
];

function assignmentNames(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter(Boolean);
}

function addQuotedBindingNames(block, bindings) {
  for (const match of block.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) {
    bindings.add(match[1]);
  }
}

test("every Worker runtime binding is inventoried without example secrets", async () => {
  const [runbook, example, gitignore, ...sources] = await Promise.all([
    readFile(new URL("../PRODUCTION_RUNBOOK.md", import.meta.url), "utf8"),
    readFile(new URL("../.dev.vars.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    ...sourcePaths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  ]);

  const bindings = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
      bindings.add(match[1]);
    }
    for (const match of source.matchAll(/\benv\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) {
      bindings.add(match[1]);
    }
    for (const match of source.matchAll(/\bconst requiredBindings\s*=\s*\[([\s\S]*?)\];/g)) {
      addQuotedBindingNames(match[1], bindings);
    }
    for (const match of source.matchAll(/\brequireConfiguration\(env,\s*\[([\s\S]*?)\]\)/g)) {
      addQuotedBindingNames(match[1], bindings);
    }
  }

  assert.deepEqual([...bindings].sort(), expectedBindings);
  for (const binding of expectedBindings) {
    assert.ok(runbook.includes("| `" + binding + "` |"));
  }

  const assignments = assignmentNames(example);
  assert.deepEqual(
    assignments.map((match) => match[1]).sort(),
    expectedBindings.filter((binding) => binding !== "ASSETS"),
  );
  for (const [, , value] of assignments) assert.equal(value, "");

  assert.match(gitignore, /^\.dev\.vars$/m);
  assert.match(gitignore, /^\.dev\.vars\.\*$/m);
  assert.match(gitignore, /^!\.dev\.vars\.example$/m);
});
