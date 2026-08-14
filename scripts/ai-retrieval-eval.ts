import { rerankAiRetrievalCandidates, resolveAiRetrievalQuery } from "../src/lib/ai-retrieval-ranking";

type EvalCandidate = Readonly<{ expected?: boolean }>;

function candidate(
  id: string,
  content: string,
  semanticRank: number,
  keywordRank: number | null = null,
  sourceId = id,
  preferred = false,
) {
  return {
    candidate: { expected: id === "expected" },
    id,
    sourceType: "WorkPreset",
    sourceId,
    sourceField: "WorkPreset.description",
    citationLabel: "Saved job",
    content,
    contentHash: `hash-${id}`,
    semanticRank,
    semanticScore: 1 / semanticRank,
    keywordRank,
    keywordScore: keywordRank ? 1 / keywordRank : null,
    preferred,
  };
}

const results = [
  {
    name: "exact identifier beats flat semantic match",
    passed: rerankAiRetrievalCandidates<EvalCandidate>({
      query: "ULTRAVERDANT42 citrus treatment",
      limit: 2,
      candidates: [
        candidate("semantic", "General garden care", 1),
        candidate("expected", "ULTRAVERDANT42 citrus treatment", 4, 1),
      ],
    })[0]?.id === "expected",
  },
  {
    name: "semantic leader remains first without lexical evidence",
    passed: rerankAiRetrievalCandidates<EvalCandidate>({
      query: "seasonal outdoor service",
      limit: 2,
      candidates: [
        candidate("expected", "Garden maintenance", 1),
        candidate("other", "Roofing material", 2),
      ],
    })[0]?.id === "expected",
  },
  {
    name: "selected entity preference wins a near tie",
    passed: rerankAiRetrievalCandidates<EvalCandidate>({
      query: "repair scope",
      limit: 2,
      candidates: [
        candidate("other", "repair scope", 1, 1),
        candidate("expected", "repair scope", 2, 2, "selected-quote", true),
      ],
    })[0]?.id === "expected",
  },
  {
    name: "overlap diversity returns three sources",
    passed: new Set(rerankAiRetrievalCandidates<EvalCandidate>({
      query: "roof repair",
      limit: 4,
      candidates: [
        candidate("a1", "roof repair one", 1, null, "a"),
        candidate("a2", "roof repair two", 2, null, "a"),
        candidate("a3", "roof repair three", 3, null, "a"),
        candidate("b", "roof repair material", 4, null, "b"),
        candidate("c", "roof repair labor", 5, null, "c"),
      ],
    }).map((entry) => entry.sourceId)).size === 3,
  },
  {
    name: "vague same-task follow-up is rewritten",
    passed: resolveAiRetrievalQuery({
      query: "What about labor?",
      priorUserQueries: ["Draft a roof repair quote"],
    }).mode === "same_task_context_v1",
  },
];

const passed = results.filter((result) => result.passed).length;
const score = passed / results.length;
console.log(JSON.stringify({ suite: "ai-retrieval", passed, total: results.length, score, results }, null, 2));
if (score < 1) process.exitCode = 1;
