import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeSupportedLogoDataUrl,
  generateQuotePdfBuffer,
  normalizeQuotePdfTemplateId,
  type QuotePdfData,
  type QuotePdfLogoPosition,
  type QuotePdfTemplateId,
} from "../../src/services/quote-pdf";

const INTERNAL_COST_SENTINEL = 4321.09;

function countPdfPages(pdf: Buffer): number {
  return pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

function extractUncompressedPdfText(pdf: Buffer): string {
  const source = pdf.toString("latin1");
  const textRuns: string[] = [];

  for (const textArray of source.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
    const fragments: string[] = [];
    for (const hexString of textArray[1].matchAll(/<([0-9a-fA-F]+)>/g)) {
      fragments.push(Buffer.from(hexString[1], "hex").toString("latin1"));
    }
    if (fragments.length > 0) textRuns.push(fragments.join(""));
  }

  return textRuns.join("\n");
}

async function buildLogoDataUrl(): Promise<string> {
  const logo = await readFile("web/public/favicon.png");
  return `data:image/png;base64,${logo.toString("base64")}`;
}

async function buildPdfData(
  templateId: QuotePdfTemplateId = "modern",
  logoPosition: QuotePdfLogoPosition = "left",
): Promise<QuotePdfData & { internalCostSubtotal: number }> {
  return {
    quoteId: "quote-12345678",
    serviceType: "HVAC",
    status: "DRAFT",
    title: "Customer-facing commercial replacement proposal",
    scopeText: "Remove the existing equipment, install the new system, complete startup testing, and clean the work area.",
    createdAt: new Date("2026-04-10T12:00:00.000Z"),
    sentAt: null,
    internalCostSubtotal: INTERNAL_COST_SENTINEL,
    customerPriceSubtotal: 12_500,
    taxAmount: 1_000,
    totalAmount: 13_500,
    customer: {
      fullName: "Jordan Customer",
      email: "jordan.customer@example.com",
      phone: "(555) 123-4567",
    },
    tenant: {
      name: "North County Heating, Cooling, Electrical, Plumbing, and Property Services",
      timezone: "America/Los_Angeles",
    },
    branding: {
      templateId,
      primaryColor: "#225588",
      logoUrl: await buildLogoDataUrl(),
      logoPosition,
      showQuoteFlyAttribution: true,
      businessEmail: "commercial-estimating-and-service@example.com",
      businessPhone: "(555) 111-2222 extension 12345",
      addressLine1: "12345 Very Long Industrial Service Corridor and Operations Center",
      addressLine2: "Building 900, Suite 1200, Receiving Entrance Near the East Gate",
      city: "Rancho Santa Margarita",
      state: "California",
      postalCode: "92688-1234",
      componentColors: {
        headerBgColor: "#225588",
        sectionTitleColor: "#225588",
        tableHeaderBgColor: "#225588",
        tableHeaderTextColor: "#ffffff",
        totalsColor: "#225588",
        footerTextColor: "#334455",
      },
    },
    lineItems: [
      {
        description: "Customer-visible equipment, installation labor, startup testing, haul-away, and closeout documentation",
        quantity: 1,
        unitPrice: 12_500,
      },
    ],
  };
}

test("renders all canonical templates and logo positions", async () => {
  const templates: QuotePdfTemplateId[] = ["modern", "professional", "minimal"];
  const positions: QuotePdfLogoPosition[] = ["left", "center", "right"];

  for (const templateId of templates) {
    for (const logoPosition of positions) {
      const pdf = await generateQuotePdfBuffer(await buildPdfData(templateId, logoPosition));
      assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
      assert.ok(countPdfPages(pdf) >= 1, `${templateId}/${logoPosition} should contain a page`);
    }
  }
});

test("long titles, sender details, scope, and line items render across pages", async () => {
  const data = await buildPdfData("professional", "right");
  data.title = "Long customer quote title ".repeat(20).trim();
  data.scopeText = `${"Detailed customer-facing scope paragraph with access, protection, testing, commissioning, and cleanup requirements. ".repeat(80)}\n\n${"Additional warranty and scheduling context. ".repeat(80)}`;
  data.lineItems = Array.from({ length: 8 }, (_, index) => ({
    description: `Phase ${index + 1}: ${"Long customer-visible work description with materials, labor, testing, and closeout requirements. ".repeat(35)}`,
    quantity: index + 1,
    unitPrice: 1_000 + index * 125,
  }));

  const pdf = await generateQuotePdfBuffer(data);
  assert.ok(countPdfPages(pdf) >= 3, "long content should create a multipage PDF");
});

test("text extraction contains customer output and excludes internal cost", async () => {
  const data = await buildPdfData("modern", "center");
  const pdf = await generateQuotePdfBuffer(data, { compress: false });
  const extractedText = extractUncompressedPdfText(pdf);
  const normalizedText = extractedText.replace(/\s+/g, " ");

  assert.match(normalizedText, /Jordan Customer/);
  assert.match(normalizedText, /Customer-facing commercial replacement proposal/);
  assert.match(normalizedText, /Customer-visible equipment, installation labor/);
  assert.match(normalizedText, /Questions about this quote\? Contact North County Heating/);
  assert.doesNotMatch(normalizedText, /Internal cost/i);
  assert.doesNotMatch(normalizedText, /\$4,321\.09/);
});

test("legacy templates normalize and remote or forged logos are rejected", () => {
  assert.equal(normalizeQuotePdfTemplateId("bold"), "professional");
  assert.equal(normalizeQuotePdfTemplateId("classic"), "professional");
  assert.equal(normalizeQuotePdfTemplateId("unknown"), "modern");
  assert.equal(decodeSupportedLogoDataUrl("https://127.0.0.1/private-logo.png"), null);
  assert.equal(decodeSupportedLogoDataUrl("data:image/png;base64,Zm9yZ2Vk"), null);
});
