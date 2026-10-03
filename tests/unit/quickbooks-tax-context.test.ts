import assert from "node:assert/strict";
import { it } from "node:test";
import { invoiceTaxContextInputSchema } from "../../src/services/quickbooks-tax-context";

function input() {
  const mapping = { id: "map-id", reviewVersion: 1, reviewedAtUtc: "2026-09-23T12:00:00.000Z", providerId: "52" };
  const address = { Line1: "123 Synthetic Street", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" };
  return { invoiceId: "invoice-id", invoiceVersion: 1, expectedRevision: 0, idempotencyKey: "00000000-0000-4000-8000-000000000000",
    transactionDate: "2026-09-23", origin: address, destination: { ...address },
    connection: { id: "connection-id", realmId: "12345", environment: "sandbox", connectedAtUtc: "2026-09-23T12:00:00.000Z", generation: 1 },
    customerMapping: mapping, lines: [{ invoiceLineItemId: "line-id", taxIntent: "TAXABLE", itemMapping: mapping }] };
}
it("accepts only an explicit valid transaction date and structured US address", () => {
  assert.equal(invoiceTaxContextInputSchema.safeParse(input()).success, true);
  for (const date of [undefined, "", "2026-02-30", "2026-13-01", "2026-09-23T00:00:00Z"]) {
    assert.equal(invoiceTaxContextInputSchema.safeParse({ ...input(), transactionDate: date }).success, false);
  }
  for (const patch of [{ Country: "CA" }, { CountrySubDivisionCode: "PR" }, { CountrySubDivisionCode: "ca" }, { PostalCode: "9021" }, { City: " " }, { Line1: "bad\u0000address" }, { freeform: "not authoritative" }]) {
    assert.equal(invoiceTaxContextInputSchema.safeParse({ ...input(), destination: { ...input().destination, ...patch } }).success, false);
  }
});
it("requires explicit intent and expected source versions without accepting caller monetary/provider facts", () => {
  for (const intent of [undefined, "", "EXEMPT", "UNKNOWN"]) {
    const value = input(); value.lines[0].taxIntent = intent as string;
    assert.equal(invoiceTaxContextInputSchema.safeParse(value).success, false);
  }
  for (const field of ["amount", "description", "unitPrice", "providerObservations"]) {
    const value = input(); Object.assign(value.lines[0], { [field]: "caller supplied" });
    assert.equal(invoiceTaxContextInputSchema.safeParse(value).success, false);
  }
  const value = input(); value.connection.generation = 0;
  assert.equal(invoiceTaxContextInputSchema.safeParse(value).success, false);
  value.connection.generation = 1; value.customerMapping.reviewVersion = 0;
  assert.equal(invoiceTaxContextInputSchema.safeParse(value).success, false);
});
it("normalizes human address whitespace while preserving exact opaque identifiers", () => {
  const value = input(); value.origin.Line1 = "  123 Synthetic Street  ";
  assert.equal(invoiceTaxContextInputSchema.parse(value).origin.Line1, "123 Synthetic Street");
  value.invoiceId = " invoice-id ";
  assert.equal(invoiceTaxContextInputSchema.safeParse(value).success, false);
});
