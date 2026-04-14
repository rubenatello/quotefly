import "dotenv/config";
import { parseChatToQuotePrompt } from "../src/services/chat-to-quote";
import type { ServiceCategory } from "../src/services/quote-generator";

type EvalCase = {
  id: string;
  prompt: string;
  expectedServiceType: ServiceCategory;
  expectedPhone?: string;
  requiredKeywords: string[];
  minLineCount: number;
};

type EvalResult = {
  id: string;
  score: number;
  serviceType: ServiceCategory;
  misses: string[];
};

const EVAL_CASES: EvalCase[] = [
  {
    id: "roof-replace-typo",
    prompt: "New quote for Jane Doe 415-555-0101. Replce 1800 sq ft asphlt shingle roof, include permit and disposal.",
    expectedServiceType: "ROOFING",
    expectedPhone: "4155550101",
    requiredKeywords: ["shingle", "permit", "disposal"],
    minLineCount: 2,
  },
  {
    id: "roof-leak-chimney",
    prompt: "Quote for Mark 916-555-0122: roof leak near chimney, repair flashing and run leak diagnostic.",
    expectedServiceType: "ROOFING",
    expectedPhone: "9165550122",
    requiredKeywords: ["leak", "flashing"],
    minLineCount: 1,
  },
  {
    id: "flooring-lvp",
    prompt: "New quote for Ross Geller 818-255-3131. Install 650 square feet of LVP flooring with underlayment and trim.",
    expectedServiceType: "FLOORING",
    expectedPhone: "8182553131",
    requiredKeywords: ["lvp", "underlayment", "trim"],
    minLineCount: 2,
  },
  {
    id: "flooring-hardwood-typo",
    prompt: "Estimate for Alex 213-555-0145: 1200 sq ft hardwod install, subfloor levelng, baseboard reinstall.",
    expectedServiceType: "FLOORING",
    expectedPhone: "2135550145",
    requiredKeywords: ["hardwood", "subfloor", "baseboard"],
    minLineCount: 2,
  },
  {
    id: "hvac-heat-pump",
    prompt: "Quote for Ana 602-555-2233. Replace 4-ton heat pump and add smart thermostat.",
    expectedServiceType: "HVAC",
    expectedPhone: "6025552233",
    requiredKeywords: ["heat pump", "thermostat"],
    minLineCount: 1,
  },
  {
    id: "hvac-mini-split-typo",
    prompt: "New quote for Omar 714-555-0988 mini split instal 2 zones and duct sealing package.",
    expectedServiceType: "HVAC",
    expectedPhone: "7145550988",
    requiredKeywords: ["mini", "duct"],
    minLineCount: 1,
  },
  {
    id: "plumbing-water-heater",
    prompt: "Quote for Sara 818-555-9988. Replace tank water heater and hydro-jet kitchen drain.",
    expectedServiceType: "PLUMBING",
    expectedPhone: "8185559988",
    requiredKeywords: ["water heater", "hydro"],
    minLineCount: 2,
  },
  {
    id: "plumbing-sewer-camera",
    prompt: "Estimate for Bob 323-555-6677: sewer camera inspection plus hydro jetting for main line clog.",
    expectedServiceType: "PLUMBING",
    expectedPhone: "3235556677",
    requiredKeywords: ["camera", "hydro", "clog"],
    minLineCount: 1,
  },
  {
    id: "plumbing-drane-typo",
    prompt: "Qte for Tina 562-555-1212 unclog drane and hydro jetting main line.",
    expectedServiceType: "PLUMBING",
    expectedPhone: "5625551212",
    requiredKeywords: ["drain", "hydro", "clog"],
    minLineCount: 1,
  },
  {
    id: "gardening-drip",
    prompt: "Quote for Luis 714-555-2211. Install drip irrigation and refresh planting beds with mulch.",
    expectedServiceType: "GARDENING",
    expectedPhone: "7145552211",
    requiredKeywords: ["drip", "mulch", "planting"],
    minLineCount: 2,
  },
  {
    id: "gardening-tree-typo",
    prompt: "New quote for Cam 909-555-3434 tree triming, hedge trimming, seasonal clean up.",
    expectedServiceType: "GARDENING",
    expectedPhone: "9095553434",
    requiredKeywords: ["tree", "hedge", "cleanup"],
    minLineCount: 1,
  },
  {
    id: "construction-remodel",
    prompt: "Estimate for Delta LLC 661-555-7788 kitchen remodel demo haul away and site prep.",
    expectedServiceType: "CONSTRUCTION",
    expectedPhone: "6615557788",
    requiredKeywords: ["demo", "site prep"],
    minLineCount: 1,
  },
  {
    id: "construction-framing",
    prompt: "Quote for Nico 408-555-5544 framing package and general labor for garage conversion.",
    expectedServiceType: "CONSTRUCTION",
    expectedPhone: "4085555544",
    requiredKeywords: ["framing", "labor"],
    minLineCount: 1,
  },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePhone(value?: string | null) {
  if (!value) return "";
  return value.replace(/\D/g, "").slice(-10);
}

function keywordHit(text: string, keyword: string) {
  const normalizedText = normalize(text);
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return true;
  return normalizedText.includes(normalizedKeyword);
}

function scoreCase(testCase: EvalCase, parsed: ReturnType<typeof parseChatToQuotePrompt>): EvalResult {
  const misses: string[] = [];
  let score = 0;

  if (parsed.serviceType === testCase.expectedServiceType) {
    score += 35;
  } else {
    misses.push(`serviceType expected ${testCase.expectedServiceType}, got ${parsed.serviceType}`);
  }

  if (!testCase.expectedPhone || normalizePhone(parsed.customerPhone) === normalizePhone(testCase.expectedPhone)) {
    score += 20;
  } else {
    misses.push(`phone parse mismatch (expected ${testCase.expectedPhone}, got ${parsed.customerPhone ?? "none"})`);
  }

  const combinedText = `${parsed.title} ${parsed.scopeText} ${parsed.lineItems.map((item) => item.description).join(" ")}`;
  const requiredHitCount = testCase.requiredKeywords.filter((keyword) => keywordHit(combinedText, keyword)).length;
  const keywordRatio = testCase.requiredKeywords.length
    ? requiredHitCount / testCase.requiredKeywords.length
    : 1;
  score += Math.round(keywordRatio * 30);
  if (keywordRatio < 1) {
    misses.push(`keyword coverage ${requiredHitCount}/${testCase.requiredKeywords.length}`);
  }

  if (parsed.lineItems.length >= testCase.minLineCount) {
    score += 15;
  } else {
    misses.push(`line count ${parsed.lineItems.length} below min ${testCase.minLineCount}`);
  }

  return {
    id: testCase.id,
    score,
    serviceType: parsed.serviceType,
    misses,
  };
}

async function run() {
  const mode = (process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] ?? "parser").toLowerCase();
  const passScore = Number(process.env.AI_EVAL_PASS_SCORE ?? "92");
  const results: EvalResult[] = [];
  const aiParser =
    mode === "ai"
      ? (await import("../src/services/ai-quote")).aiParseChatToQuotePrompt
      : null;

  for (const testCase of EVAL_CASES) {
    const parsed = aiParser
      ? await aiParser(testCase.prompt, { strictAi: true })
      : parseChatToQuotePrompt(testCase.prompt);

    results.push(scoreCase(testCase, parsed));
  }

  const totalScore = results.reduce((sum, item) => sum + item.score, 0);
  const maxScore = EVAL_CASES.length * 100;
  const averageScore = Number(((totalScore / maxScore) * 100).toFixed(2));

  console.log(`AI Quote Eval Mode: ${mode}`);
  console.log(`Cases: ${EVAL_CASES.length}`);
  console.log(`Average Score: ${averageScore}/100`);
  console.log("");
  for (const result of results) {
    const status = result.score >= 92 ? "PASS" : "FAIL";
    console.log(`${status} ${result.id} -> ${result.score}/100 (${result.serviceType})`);
    if (result.misses.length > 0) {
      console.log(`  misses: ${result.misses.join("; ")}`);
    }
  }

  if (averageScore < passScore) {
    console.error(`\nAI eval failed gate ${passScore}.`);
    process.exit(1);
  }

  console.log(`\nAI eval passed gate ${passScore}.`);
}

void run();
