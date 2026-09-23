import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("every persisted Prisma timestamp uses PostgreSQL timestamptz", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  let model = "";
  const timestampFields = schema
    .split(/\r?\n/)
    .map((line, index) => {
      const declaration = /^model\s+(\w+)\s*\{/.exec(line);
      if (declaration) model = declaration[1];
      return { line: line.trim(), number: index + 1, model };
    })
    .filter(({ line }) => !line.startsWith("//") && /^\w+\s+DateTime\??\b/.test(line));

  assert.ok(timestampFields.length > 0, "Expected timestamp fields in the Prisma schema.");
  const calendarDates = timestampFields.filter((field) => field.model === "InvoiceTaxContext" && /^transactionDate\s/.test(field.line));
  assert.equal(calendarDates.length, 1, "Expected exactly one explicitly confirmed tax transaction calendar date.");
  for (const field of timestampFields) {
    if (calendarDates.includes(field)) {
      // A business transaction date is a calendar date, not an instant; it must
      // never shift when a tenant or provider renders a different time zone.
      assert.match(field.line, /^transactionDate\s+DateTime\s+@db\.Date\s*$/);
      continue;
    }
    assert.match(
      field.line,
      /@db\.Timestamptz\(3\)/,
      `Timestamp field on schema line ${field.number} must use @db.Timestamptz(3).`,
    );
  }
});
