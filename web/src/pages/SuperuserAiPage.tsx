import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiError,
  api,
  type AiAssistantContext,
  type AiAssistantRequestedTool,
  type AiAssistantResponse,
  type DataClassification,
  type InternalAiQualitySummary,
  type InternalAiQualityTenantRow,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { Alert, Badge, Button, Card, CardHeader, Input, LoadingState, PageHeader, Select, Textarea } from "../components/ui";

const ASSISTANT_TOOLS: Array<{ value: AiAssistantRequestedTool; label: string }> = [
  { value: "AUTO", label: "Auto route" },
  { value: "SEARCH_CUSTOMERS", label: "Search customers" },
  { value: "DRAFT_QUOTE", label: "Draft quote" },
  { value: "SUMMARIZE_PIPELINE", label: "Summarize pipeline" },
  { value: "RANK_PROFITABLE_JOBS", label: "Rank profitable jobs" },
];

const CONTEXT_PAGES: Array<{ value: NonNullable<AiAssistantContext["currentPage"]>; label: string }> = [
  { value: "dashboard", label: "Dashboard" },
  { value: "customers", label: "Customers" },
  { value: "quotes", label: "Quotes" },
  { value: "analytics", label: "Analytics" },
  { value: "products", label: "Products" },
];

function classificationTone(classification: DataClassification): "amber" | "blue" | "slate" | "emerald" {
  if (classification === "C3_FINANCIAL_CONFIDENTIAL" || classification === "C4_RESTRICTED") return "amber";
  if (classification === "C2_CUSTOMER_CONFIDENTIAL") return "blue";
  if (classification === "C1_BUSINESS_INTERNAL") return "slate";
  return "emerald";
}

function formatUsage(value: number | null) {
  return value === null ? "Unlimited" : value.toLocaleString();
}

type KodyTestRequest = {
  message: string;
  tool: AiAssistantRequestedTool;
  context: AiAssistantContext;
};

function toPrettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function dateInputDaysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function redactedKodyTestRequest(request: KodyTestRequest) {
  return {
    messageLength: request.message.length,
    promptRef: "redacted in visible evidence",
    tool: request.tool,
    context: {
      currentPage: request.context.currentPage,
      serviceType: request.context.serviceType,
      dateFrom: request.context.dateFrom,
      dateTo: request.context.dateTo,
      limit: request.context.limit,
      includeArchived: request.context.includeArchived,
      search: request.context.search ? "[REDACTED_SEARCH_HINT]" : undefined,
      customerId: request.context.customerId ? "[REDACTED_CUSTOMER_REF]" : undefined,
      quoteId: request.context.quoteId ? "[REDACTED_QUOTE_REF]" : undefined,
    },
  };
}

export function SuperuserAiPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<InternalAiQualitySummary | null>(null);
  const [tenants, setTenants] = useState<InternalAiQualityTenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState("Rank profitable jobs by service for the last 90 days.");
  const [testTool, setTestTool] = useState<AiAssistantRequestedTool>("AUTO");
  const [testPage, setTestPage] = useState<NonNullable<AiAssistantContext["currentPage"]>>("analytics");
  const [testSearch, setTestSearch] = useState("");
  const [testDateFrom, setTestDateFrom] = useState(dateInputDaysAgo(90));
  const [testDateTo, setTestDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [testLimit, setTestLimit] = useState("8");
  const [testIncludeArchived, setTestIncludeArchived] = useState(false);
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResponse, setTestResponse] = useState<AiAssistantResponse | null>(null);
  const [lastTestRequest, setLastTestRequest] = useState<KodyTestRequest | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [showSensitiveDiagnostics, setShowSensitiveDiagnostics] = useState(false);

  useEffect(() => {
    setSEOMetadata({
      title: "Superuser AI Quality",
      description: "Internal AI quality and spend telemetry dashboard.",
    });
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [summaryResult, tenantResult] = await Promise.all([
        api.internal.aiQuality.summary({ days: 30 }),
        api.internal.aiQuality.tenants({ days: 30, limit: 25 }),
      ]);
      setSummary(summaryResult);
      setTenants(tenantResult.tenants);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading superuser AI metrics.");
    } finally {
      setLoading(false);
    }
  }

  function buildKodyTestRequest(): KodyTestRequest | null {
    const message = testPrompt.trim();
    if (!message) return null;

    const parsedLimit = Number.parseInt(testLimit, 10);
    const context: AiAssistantContext = {
      currentPage: testPage,
      limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 20)) : 8,
      includeArchived: testIncludeArchived,
      ...(testSearch.trim() ? { search: testSearch.trim() } : {}),
      ...(testDateFrom ? { dateFrom: testDateFrom } : {}),
      ...(testDateTo ? { dateTo: testDateTo } : {}),
    };

    return {
      message,
      tool: testTool,
      context,
    };
  }

  async function runKodyTest() {
    const requestBody = buildKodyTestRequest();
    if (!requestBody || testSubmitting) return;

    setTestSubmitting(true);
    setTestError(null);
    setTestResponse(null);
    setLastTestRequest(requestBody);
    setCopyStatus(null);
    setShowSensitiveDiagnostics(false);
    try {
      const response = await api.internal.aiQuality.assistantTest(requestBody);
      setTestResponse(response);
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : "Kody test request failed.");
    } finally {
      setTestSubmitting(false);
    }
  }

  async function copyKodyEvidence() {
    const requestBody = lastTestRequest ?? buildKodyTestRequest();
    if (!requestBody) return;

    const evidence = {
      generatedAtUtc: new Date().toISOString(),
      endpoint: "/v1/internal/ai-quality/assistant-test",
      request: showSensitiveDiagnostics ? requestBody : redactedKodyTestRequest(requestBody),
      response: testResponse
        ? showSensitiveDiagnostics
          ? testResponse
          : {
              assistant: {
                tool: testResponse.assistant.tool,
                generatedAtUtc: testResponse.assistant.generatedAtUtc,
                policyVersion: testResponse.assistant.policyVersion,
                maxClassification: testResponse.assistant.maxClassification,
                answer: testResponse.assistant.answer,
                resultCount: testResponse.assistant.results.length,
                citationCount: testResponse.assistant.citations.length,
                actionLabels: testResponse.assistant.actions.map((action) => action.label),
                auditEventId: testResponse.assistant.auditEventId,
                diagnostics: testResponse.assistant.diagnostics,
                hiddenFieldCount: testResponse.assistant.fieldsExcluded.length,
              },
              usage: testResponse.usage,
            }
        : null,
      error: testError,
      note: showSensitiveDiagnostics
        ? "Generated from the audited superuser Kody test console after sensitive diagnostics were revealed. It may contain tenant-scoped C2/C3 workspace data."
        : "Generated from the audited superuser Kody test console. Raw prompt text, structured results, and hidden-field lists are redacted until sensitive diagnostics are revealed.",
    };

    try {
      await navigator.clipboard.writeText(toPrettyJson(evidence));
      setCopyStatus("Evidence JSON copied.");
    } catch {
      setCopyStatus("Copy failed. Select and copy the JSON manually.");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Superuser AI Quality" subtitle="Platform-only view for AI quality, usage, and spend telemetry." />
        <Card variant="elevated" padding="lg" className="text-sm text-slate-600">
          Loading platform AI metrics...
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Superuser AI Quality"
        subtitle="Platform-only metrics. Not visible to tenant users."
        actions={<Button variant="outline" onClick={() => navigate("/app/internal/admin")}>Operator console</Button>}
      />

      {error ? (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <Card variant="elevated" padding="lg" data-testid="superuser-kody-test-console">
        <CardHeader
          title="Kody Response Test Console"
          subtitle="Runs an audited internal wrapper around the tenant-scoped assistant as your current signed-in superuser workspace. Use this to inspect poor answers before changing prompts or retrieval."
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="space-y-3">
            <Textarea
              label="Prompt"
              value={testPrompt}
              onChange={(event) => setTestPrompt(event.target.value)}
              rows={5}
              placeholder="Ask Kody exactly what you expect a contractor to ask..."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Tool"
                value={testTool}
                onChange={(event) => setTestTool(event.target.value as AiAssistantRequestedTool)}
                options={ASSISTANT_TOOLS}
              />
              <Select
                label="Current page context"
                value={testPage}
                onChange={(event) => setTestPage(event.target.value as NonNullable<AiAssistantContext["currentPage"]>)}
                options={CONTEXT_PAGES}
              />
              <Input
                label="Search hint"
                value={testSearch}
                onChange={(event) => setTestSearch(event.target.value)}
                placeholder="Optional customer, quote, service, or phrase"
              />
              <Input
                label="Limit"
                type="number"
                min="1"
                max="20"
                value={testLimit}
                onChange={(event) => setTestLimit(event.target.value)}
              />
              <Input
                label="Date from"
                type="date"
                value={testDateFrom}
                onChange={(event) => setTestDateFrom(event.target.value)}
              />
              <Input
                label="Date to"
                type="date"
                value={testDateTo}
                onChange={(event) => setTestDateTo(event.target.value)}
              />
            </div>
            <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={testIncludeArchived}
                onChange={(event) => setTestIncludeArchived(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-quotefly-blue"
              />
              <span>
                Include archived quote aggregates for business-insight tools when the backend role policy allows it.
                <span className="mt-0.5 block text-xs text-slate-500">Customer lookup still searches active customers only; every test remains scoped to the authenticated tenant and role permissions.</span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void runKodyTest()} loading={testSubmitting} disabled={!testPrompt.trim()}>
                Run Kody test
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTestPrompt("Find customers due for follow-up and explain why.");
                  setTestTool("AUTO");
                  setTestPage("customers");
                  setTestSearch("");
                  setTestDateFrom("");
                  setTestDateTo("");
                }}
              >
                Follow-up prompt
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTestPrompt("Rank profitable jobs by service for the last 90 days and explain the data used.");
                  setTestTool("RANK_PROFITABLE_JOBS");
                  setTestPage("analytics");
                  setTestSearch("");
                  setTestDateFrom(dateInputDaysAgo(90));
                  setTestDateTo(new Date().toISOString().slice(0, 10));
                }}
              >
                Profit prompt
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTestDateFrom(dateInputDaysAgo(90));
                  setTestDateTo(new Date().toISOString().slice(0, 10));
                }}
              >
                Last 90 days
              </Button>
            </div>
            <p className="text-xs leading-5 text-slate-500">
              This console does not expose OpenAI keys, raw hidden prompt context, or cross-tenant selectors. Audit evidence comes from the assistant response id.
            </p>
          </div>

          <KodyTestResponsePanel
            request={lastTestRequest ?? buildKodyTestRequest()}
            response={testResponse}
            error={testError}
            loading={testSubmitting}
            copyStatus={copyStatus}
            onCopy={() => void copyKodyEvidence()}
            showSensitiveDiagnostics={showSensitiveDiagnostics}
            onToggleSensitiveDiagnostics={() => setShowSensitiveDiagnostics((current) => !current)}
          />
        </div>
      </Card>

      {summary ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard label="Runs (30d)" value={summary.totals.totalRuns.toLocaleString()} />
          <MetricCard label="Active tenants" value={summary.totals.activeTenants.toLocaleString()} />
          <MetricCard label="Spend (30d)" value={`$${summary.totals.totalSpendUsd.toFixed(2)}`} />
          <MetricCard label="Avg cost/run" value={`$${summary.averages.spendUsdPerRun.toFixed(4)}`} />
          <MetricCard label="No-patch rate" value={`${summary.quality.noPatchRatePct.toFixed(1)}%`} />
          <MetricCard label="Low-confidence" value={`${summary.quality.lowConfidenceRatePct.toFixed(1)}%`} />
        </div>
      ) : null}

      {summary ? (
        <Card variant="elevated" padding="lg">
          <CardHeader
            title="Model Mix"
            subtitle={`Confidence split: High ${summary.confidence.high} · Medium ${summary.confidence.medium} · Low ${summary.confidence.low}`}
          />
          <div className="space-y-2 text-sm text-slate-700">
            {summary.models.length ? (
              summary.models.map((model) => (
                <div key={model.model} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <span className="font-medium text-slate-900">{model.model}</span>
                  <span>{model.runCount} runs</span>
                  <span>${model.spendUsd.toFixed(3)} spend</span>
                  <span>{Math.round(model.averageTokensPerRun)} avg tokens/run</span>
                </div>
              ))
            ) : (
              <p className="text-slate-500">No model data for this window.</p>
            )}
          </div>
        </Card>
      ) : null}

      {summary ? (
        <Card variant="elevated" padding="lg">
          <CardHeader title="Quality Signals (30d)" subtitle="Track no-op patterns, low-confidence output, and fallback runtime usage." />
          <div className="grid gap-3 md:grid-cols-3">
            {summary.qualitySignals.map((signal) => (
              <div key={signal.key} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{signal.label}</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">{signal.count.toLocaleString()}</p>
                <p className="text-xs text-slate-500">{signal.ratePct.toFixed(1)}% of runs</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {summary ? (
        <Card variant="elevated" padding="lg">
          <CardHeader title="Trade Quality Breakdown (30d)" subtitle="Per-trade quality and spend profile." />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">Trade</th>
                  <th className="px-2 py-2">Runs</th>
                  <th className="px-2 py-2">Draft/Revise</th>
                  <th className="px-2 py-2">No patch</th>
                  <th className="px-2 py-2">Low conf</th>
                  <th className="px-2 py-2">Fallback</th>
                  <th className="px-2 py-2">Avg tokens/run</th>
                  <th className="px-2 py-2">Spend</th>
                </tr>
              </thead>
              <tbody>
                {summary.tradeBreakdown.length ? (
                  summary.tradeBreakdown.map((row) => (
                    <tr key={row.trade} className="border-t border-slate-200 text-slate-700">
                      <td className="px-2 py-2 font-medium text-slate-900">{row.trade}</td>
                      <td className="px-2 py-2">{row.runCount.toLocaleString()}</td>
                      <td className="px-2 py-2">
                        {row.draftRuns}/{row.reviseRuns}
                      </td>
                      <td className="px-2 py-2">{row.noPatchRatePct.toFixed(1)}%</td>
                      <td className="px-2 py-2">{row.lowConfidenceRatePct.toFixed(1)}%</td>
                      <td className="px-2 py-2">{row.regexFallbackRatePct.toFixed(1)}%</td>
                      <td className="px-2 py-2">{Math.round(row.averageTokensPerRun)}</td>
                      <td className="px-2 py-2">${row.spendUsd.toFixed(3)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-2 py-3 text-slate-500">
                      No trade data for this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card variant="elevated" padding="lg">
        <CardHeader title="Top Tenants by AI Spend (30d)" subtitle="Use this to audit unusual usage or low-margin AI behavior." />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2">Tenant</th>
                <th className="px-2 py-2">Runs</th>
                <th className="px-2 py-2">Spend</th>
                <th className="px-2 py-2">Avg/Run</th>
                <th className="px-2 py-2">Avg Tokens/Run</th>
                <th className="px-2 py-2">No patch</th>
                <th className="px-2 py-2">Low conf</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length ? (
                tenants.map((tenant) => (
                  <tr key={tenant.tenantId} className="border-t border-slate-200 text-slate-700">
                    <td className="px-2 py-2 font-medium text-slate-900">{tenant.tenantName}</td>
                    <td className="px-2 py-2">{tenant.runCount.toLocaleString()}</td>
                    <td className="px-2 py-2">${tenant.spendUsd.toFixed(3)}</td>
                    <td className="px-2 py-2">${tenant.averageSpendUsdPerRun.toFixed(4)}</td>
                    <td className="px-2 py-2">{Math.round(tenant.averageTokensPerRun)}</td>
                    <td className="px-2 py-2">{tenant.noPatchRatePct.toFixed(1)}%</td>
                    <td className="px-2 py-2">{tenant.lowConfidenceRatePct.toFixed(1)}%</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-slate-500">
                    No tenant AI usage in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="elevated" padding="md">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </Card>
  );
}

function KodyTestResponsePanel({
  request,
  response,
  error,
  loading,
  copyStatus,
  onCopy,
  showSensitiveDiagnostics,
  onToggleSensitiveDiagnostics,
}: {
  request: KodyTestRequest | null;
  response: AiAssistantResponse | null;
  error: string | null;
  loading: boolean;
  copyStatus: string | null;
  onCopy: () => void;
  showSensitiveDiagnostics: boolean;
  onToggleSensitiveDiagnostics: () => void;
}) {
  if (loading) {
    return (
      <LoadingState
        title="Running Kody test"
        description="Calling the audited assistant test endpoint and waiting for cited output."
        rows={4}
      />
    );
  }

  if (error) {
    return (
      <Alert tone="error">
        {error}
      </Alert>
    );
  }

  if (!response) {
    return (
      <div className="space-y-3">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
          <p className="text-sm font-semibold text-slate-800">No test response yet</p>
          <p className="mt-1 text-sm text-slate-500">Run a prompt to inspect the answer, retrieval evidence, hidden fields, actions, and audit id.</p>
        </div>
        {request ? (
          <JsonDetails title="Request preview" value={request} />
        ) : null}
      </div>
    );
  }

  const assistant = response.assistant;
  return (
    <div className="space-y-3" data-testid="superuser-kody-test-response">
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{assistant.tool}</Badge>
          <Badge tone={classificationTone(assistant.maxClassification)}>{assistant.maxClassification}</Badge>
          <Badge tone="slate">Policy {assistant.policyVersion}</Badge>
          <Badge tone={assistant.diagnostics.answerMode === "LLM_COMPOSED" ? "emerald" : "slate"}>
            {assistant.diagnostics.answerMode === "LLM_COMPOSED" ? "LLM composed" : "Deterministic"}
          </Badge>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-800">{assistant.answer}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onCopy}>
          {showSensitiveDiagnostics ? "Copy full evidence JSON" : "Copy visible evidence JSON"}
        </Button>
        <Button type="button" variant="outline" onClick={onToggleSensitiveDiagnostics}>
          {showSensitiveDiagnostics ? "Hide sensitive diagnostics" : "Reveal sensitive diagnostics"}
        </Button>
        {copyStatus ? <span className="text-xs font-medium text-slate-500">{copyStatus}</span> : null}
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
        Sensitive diagnostics include raw prompt text, structured result rows, hidden-field lists, and full action payloads. Reveal them only while debugging a specific Kody response.
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <DiagnosticCard label="Audit event" value={assistant.auditEventId} mono />
        <DiagnosticCard label="Credits used" value={response.usage.consumedCredits.toLocaleString()} />
        <DiagnosticCard label="Remaining credits" value={formatUsage(response.usage.monthlyCreditsRemaining)} />
        <DiagnosticCard label="Answer model" value={assistant.diagnostics.model ?? "deterministic"} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">Effective retrieval diagnostics</p>
          <span className="text-xs font-medium text-slate-500">
            {assistant.diagnostics.resultCount.toLocaleString()} rows · {assistant.diagnostics.citationCount.toLocaleString()} citations
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">{assistant.diagnostics.archivePolicy}</p>
        {assistant.diagnostics.emptyReason ? (
          <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
            {assistant.diagnostics.emptyReason}
          </p>
        ) : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {Object.entries(assistant.diagnostics.filters).map(([key, value]) => (
            <div key={key} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <p className="font-semibold uppercase tracking-wide text-slate-500">{key}</p>
              <p className="mt-1 break-all font-medium text-slate-800">{value === null ? "n/a" : String(value)}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Citations</p>
        {assistant.citations.length ? (
          <div className="mt-2 grid gap-2">
            {assistant.citations.map((citation) => (
              <div key={`${citation.key}-${citation.label}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={classificationTone(citation.classification)}>{citation.classification}</Badge>
                  <span className="font-semibold text-slate-900">{citation.label}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{citation.key} · {citation.sourceType}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">No workspace rows were cited. This is useful evidence when an answer feels generic.</p>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">Results returned</p>
          {!showSensitiveDiagnostics ? (
            <p className="mt-2 text-sm text-slate-500">
              {assistant.results.length.toLocaleString()} structured result row{assistant.results.length === 1 ? "" : "s"} hidden until sensitive diagnostics are revealed.
            </p>
          ) : assistant.results.length ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-950 px-3 py-3 text-xs leading-5 text-slate-100">
              {JSON.stringify(assistant.results, null, 2)}
            </pre>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No structured results returned.</p>
          )}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">Guardrails and actions</p>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="font-medium text-slate-600">Fields hidden</dt>
              <dd className="mt-1 text-slate-800">
                {showSensitiveDiagnostics
                  ? assistant.fieldsExcluded.length
                    ? assistant.fieldsExcluded.join(", ")
                    : "None reported"
                  : `${assistant.fieldsExcluded.length.toLocaleString()} hidden-field label${assistant.fieldsExcluded.length === 1 ? "" : "s"} hidden until reveal`}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-600">Actions</dt>
              <dd className="mt-1 text-slate-800">{assistant.actions.length ? assistant.actions.map((action) => action.label).join(", ") : "No actions suggested"}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-600">Generated</dt>
              <dd className="mt-1 text-slate-800">{new Date(assistant.generatedAtUtc).toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      </div>

      {showSensitiveDiagnostics ? (
        <>
          <JsonDetails title="Request JSON" value={request} />
          <JsonDetails title="Response JSON" value={response} />
        </>
      ) : null}
    </div>
  );
}

function DiagnosticCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 break-all text-sm font-semibold text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  if (!value) return null;

  return (
    <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">{title}</summary>
      <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-slate-950 px-3 py-3 text-xs leading-5 text-slate-100">
        {toPrettyJson(value)}
      </pre>
    </details>
  );
}

export default SuperuserAiPage;
