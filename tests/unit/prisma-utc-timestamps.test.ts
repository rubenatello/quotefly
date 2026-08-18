import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("every persisted Prisma timestamp uses PostgreSQL timestamptz", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  const timestampFields = schema
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith("//") && /^\w+\s+DateTime\??\b/.test(line));

  assert.ok(timestampFields.length > 0, "Expected timestamp fields in the Prisma schema.");
  for (const field of timestampFields) {
    assert.match(
      field.line,
      /@db\.Timestamptz\(3\)/,
      `Timestamp field on schema line ${field.number} must use @db.Timestamptz(3).`,
    );
  }
});
