import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../scripts/ai-assistant-provider-eval.ts", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/ai-provider-eval.yml", import.meta.url), "utf8");

test("provider evaluation composes only within a governed usage reservation", () => {
  assert.match(source, /const\s+PROVIDER_EVAL_DATABASE_NAME\s*=\s*"quotefly_provider_eval_test"/);
  assert.match(source, /runWithAiUsageOperation\(prisma,\s*\{/);
  assert.match(source, /operation:\s*"AI_ASSISTANT_PROVIDER_EVAL"/);
  assert.match(source, /\(\)\s*=>\s*composeAssistantAnswer\(evalCase\.input\)/);
  assert.match(source, /kind:\s*"PROVIDER_CALL"/);
  assert.match(source, /promptText\s*!==\s*null\s*\|\|\s*ledger\.audit\.promptRedacted\s*!==\s*null/);
});

test("provider evaluation workflow provisions and migrates an isolated test database", () => {
  assert.match(workflow, /image:\s*postgres:16/);
  assert.match(workflow, /POSTGRES_DB:\s*quotefly_provider_eval_test/);
  assert.match(workflow, /DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/quotefly_provider_eval_test/);
  assert.match(workflow, /npm run prisma:generate/);
  assert.match(workflow, /npm run prisma:migrate:deploy/);
});
