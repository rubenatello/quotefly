import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  BrainCircuit,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  ScrollText,
} from "lucide-react";
import {
  ApiError,
  api,
  type DataClassification,
  type InternalControlPlaneSummary,
  type InternalDataCatalog,
  type InternalPermissionPolicy,
  type InternalRagIndexSummary,
  type InternalSuperuserAuditEvent,
  type InternalTenantMetadata,
  type InternalValidationRun,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  PageHeader,
  Select,
} from "../components/ui";

type ConsoleTab = "overview" | "tenants" | "catalog" | "permissions" | "validation" | "audit";

const TABS: Array<{ id: ConsoleTab; label: string; icon: typeof ShieldCheck }> = [
  { id: "overview", label: "Overview", icon: ShieldCheck },
  { id: "tenants", label: "Tenants", icon: Building2 },
  { id: "catalog", label: "Data explorer", icon: Database },
  { id: "permissions", label: "Permissions", icon: KeyRound },
  { id: "validation", label: "Validation", icon: RefreshCw },
  { id: "audit", label: "Audit", icon: ScrollText },
];

const CLASSIFICATIONS: Array<{ value: "" | DataClassification; label: string }> = [
  { value: "", label: "All classifications" },
  { value: "C0_PUBLIC", label: "C0 Public" },
  { value: "C1_BUSINESS_INTERNAL", label: "C1 Business internal" },
  { value: "C2_CUSTOMER_CONFIDENTIAL", label: "C2 Customer confidential" },
  { value: "C3_FINANCIAL_CONFIDENTIAL", label: "C3 Financial confidential" },
  { value: "C4_RESTRICTED", label: "C4 Restricted" },
];

function readable(value: string): string {
  return value
    .replace(/^C\d_/, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function classificationTone(classification: DataClassification) {
  if (classification === "C4_RESTRICTED") return "red" as const;
  if (classification === "C3_FINANCIAL_CONFIDENTIAL") return "amber" as const;
  if (classification === "C2_CUSTOMER_CONFIDENTIAL") return "purple" as const;
  if (classification === "C1_BUSINESS_INTERNAL") return "blue" as const;
  return "slate" as const;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "The operator console could not load this section.";
}

export function SuperuserAdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ConsoleTab>("overview");
  const [summary, setSummary] = useState<InternalControlPlaneSummary | null>(null);
  const [ragIndex, setRagIndex] = useState<InternalRagIndexSummary | null>(null);
  const [tenants, setTenants] = useState<InternalTenantMetadata[]>([]);
  const [tenantTotal, setTenantTotal] = useState(0);
  const [tenantOffset, setTenantOffset] = useState(0);
  const [tenantSearch, setTenantSearch] = useState("");
  const [tenantLifecycle, setTenantLifecycle] = useState<"active" | "deleted" | "all">("active");
  const [catalog, setCatalog] = useState<InternalDataCatalog | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [classification, setClassification] = useState<"" | DataClassification>("");
  const [ragStatus, setRagStatus] = useState<"" | "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED">("");
  const [expandedCatalogModels, setExpandedCatalogModels] = useState<Set<string>>(new Set());
  const [permissions, setPermissions] = useState<InternalPermissionPolicy | null>(null);
  const [validationRuns, setValidationRuns] = useState<InternalValidationRun[]>([]);
  const [auditEvents, setAuditEvents] = useState<InternalSuperuserAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [validationRunning, setValidationRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSEOMetadata({
      title: "QuoteFly Operator Console",
      description: "Read-only platform operations and data-governance console.",
    });
    void loadSummary();
  }, []);

  async function loadSummary() {
    setLoading(true);
    setError(null);
    try {
      const [summaryResult, ragIndexResult] = await Promise.all([
        api.internal.controlPlane.summary(),
        api.internal.controlPlane.ragIndex(),
      ]);
      setSummary(summaryResult);
      setRagIndex(ragIndexResult);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function loadTenants(offset = tenantOffset) {
    setSectionLoading(true);
    setError(null);
    try {
      const result = await api.internal.controlPlane.tenants({
        limit: 25,
        offset,
        search: tenantSearch.trim() || undefined,
        lifecycle: tenantLifecycle,
      });
      setTenants(result.tenants);
      setTenantTotal(result.pagination.total);
      setTenantOffset(result.pagination.offset);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSectionLoading(false);
    }
  }

  async function loadCatalog() {
    setSectionLoading(true);
    setError(null);
    try {
      const result = await api.internal.controlPlane.dataCatalog({
        search: catalogSearch.trim() || undefined,
        classification: classification || undefined,
        ragStatus: ragStatus || undefined,
      });
      setCatalog(result);
      setExpandedCatalogModels((current) => new Set(
        [...current].filter((modelName) => result.models.some((model) => model.model === modelName)),
      ));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSectionLoading(false);
    }
  }

  async function loadPermissions() {
    setSectionLoading(true);
    setError(null);
    try {
      setPermissions(await api.internal.controlPlane.permissions());
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSectionLoading(false);
    }
  }

  async function loadValidationRuns() {
    setSectionLoading(true);
    setError(null);
    try {
      const result = await api.internal.controlPlane.validationRuns({ limit: 25 });
      setValidationRuns(result.runs);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSectionLoading(false);
    }
  }

  async function loadAuditEvents() {
    setSectionLoading(true);
    setError(null);
    try {
      const result = await api.internal.controlPlane.auditEvents({ limit: 50 });
      setAuditEvents(result.events);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSectionLoading(false);
    }
  }

  async function changeTab(nextTab: ConsoleTab) {
    setTab(nextTab);
    setNotice(null);
    if (nextTab === "overview") return;
    if (nextTab === "tenants" && tenants.length === 0) await loadTenants(0);
    if (nextTab === "catalog" && !catalog) await loadCatalog();
    if (nextTab === "permissions" && !permissions) await loadPermissions();
    if (nextTab === "validation" && validationRuns.length === 0) await loadValidationRuns();
    if (nextTab === "audit" && auditEvents.length === 0) await loadAuditEvents();
  }

  async function runValidation() {
    setValidationRunning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.internal.controlPlane.runValidation();
      setValidationRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
      setSummary((current) => current ? { ...current, liveValidation: result.run } : current);
      setNotice(result.run.status === "PASSED"
        ? `Validation passed for ${result.run.modelCount} models and ${result.run.fieldCount} fields.`
        : `Validation found ${result.run.issueCount} review item(s).`);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setValidationRunning(false);
    }
  }

  const visibleCatalogFieldCount = useMemo(
    () => catalog?.models.reduce((total, model) => total + model.fields.length, 0) ?? 0,
    [catalog],
  );

  function toggleCatalogModel(modelName: string) {
    setExpandedCatalogModels((current) => {
      const next = new Set(current);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return next;
    });
  }

  function toggleAllCatalogModels() {
    if (!catalog) return;
    const allExpanded = catalog.models.length > 0
      && catalog.models.every((model) => expandedCatalogModels.has(model.model));
    setExpandedCatalogModels(allExpanded
      ? new Set()
      : new Set(catalog.models.map((model) => model.model)));
  }

  return (
    <div className="space-y-5" data-testid="superuser-operator-console">
      <PageHeader
        title="QuoteFly operator console"
        subtitle="Read-only platform operations, data classification, access policy, and validation evidence."
        actions={(
          <Button variant="outline" icon={<BrainCircuit size={16} />} onClick={() => navigate("/app/internal/admin/ai-quality")}>
            AI quality
          </Button>
        )}
      />

      <Alert tone="warning">
        <span className="inline-flex items-start gap-2">
          <LockKeyhole className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
          Read-only governance mode: no raw tenant rows, credentials, impersonation, policy edits, or tenant mutations.
        </span>
      </Alert>

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <nav aria-label="Operator console sections" className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max gap-2">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void changeTab(item.id)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue ${active
                  ? "border-quotefly-blue bg-quotefly-blue text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
              >
                <Icon size={16} aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>
      </nav>

      {loading ? (
        <Card variant="elevated" padding="lg" className="text-sm text-slate-600">Loading operator controls...</Card>
      ) : null}

      {!loading && tab === "overview" ? (
        <OverviewPanel summary={summary} ragIndex={ragIndex} onRefresh={() => void loadSummary()} />
      ) : null}

      {!loading && tab === "tenants" ? (
        <section className="space-y-4" aria-labelledby="tenant-panel-title">
          <Card variant="elevated" padding="lg">
            <CardHeader
              title="Tenant metadata"
              subtitle="Lifecycle, subscription state, and aggregate record counts only. Customer and provider data are excluded."
            />
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_auto] sm:items-end"
              onSubmit={(event) => { event.preventDefault(); void loadTenants(0); }}
            >
              <Input
                label="Tenant name or slug"
                value={tenantSearch}
                onChange={(event) => setTenantSearch(event.target.value)}
                placeholder="Search tenants"
                icon={<Search size={16} />}
              />
              <Select
                label="Lifecycle"
                value={tenantLifecycle}
                onChange={(event) => setTenantLifecycle(event.target.value as typeof tenantLifecycle)}
                options={[
                  { value: "active", label: "Active" },
                  { value: "deleted", label: "Deleted" },
                  { value: "all", label: "All" },
                ]}
              />
              <Button type="submit" loading={sectionLoading}>Apply</Button>
            </form>
          </Card>

          <div className="grid gap-3 xl:grid-cols-2">
            {tenants.map((tenant) => <TenantCard key={tenant.id} tenant={tenant} />)}
          </div>
          {!sectionLoading && tenants.length === 0 ? (
            <Card padding="lg" className="text-sm text-slate-600">No tenant metadata matched these filters.</Card>
          ) : null}
          <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600">
              {tenantTotal === 0 ? "0 tenants" : `${tenantOffset + 1}–${Math.min(tenantOffset + tenants.length, tenantTotal)} of ${tenantTotal}`}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" disabled={tenantOffset === 0 || sectionLoading} onClick={() => void loadTenants(Math.max(0, tenantOffset - 25))}>Previous</Button>
              <Button variant="outline" disabled={tenantOffset + tenants.length >= tenantTotal || sectionLoading} onClick={() => void loadTenants(tenantOffset + 25)}>Next</Button>
            </div>
          </div>
        </section>
      ) : null}

      {!loading && tab === "catalog" ? (
        <section className="space-y-4" aria-labelledby="catalog-panel-title">
          <Card variant="elevated" padding="lg">
            <CardHeader
              title="Data classification explorer"
              subtitle="Schema metadata only. Eligible means approved for a future tenant-scoped retrieval index, not globally searchable."
            />
            <form
              className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_240px_210px_auto] lg:items-end"
              onSubmit={(event) => { event.preventDefault(); void loadCatalog(); }}
            >
              <Input label="Model, field, or type" value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} icon={<Search size={16} />} placeholder="Quote.scopeText" />
              <Select label="Classification" value={classification} onChange={(event) => setClassification(event.target.value as typeof classification)} options={CLASSIFICATIONS} />
              <Select
                label="RAG status"
                value={ragStatus}
                onChange={(event) => setRagStatus(event.target.value as typeof ragStatus)}
                options={[
                  { value: "", label: "All RAG statuses" },
                  { value: "ELIGIBLE", label: "Eligible" },
                  { value: "EXCLUDED", label: "Excluded" },
                  { value: "REVIEW_REQUIRED", label: "Review required" },
                ]}
              />
              <Button type="submit" loading={sectionLoading}>Apply</Button>
            </form>
          </Card>

          {catalog ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricCard label="Visible models" value={catalog.models.length.toLocaleString()} />
              <MetricCard label="Visible fields" value={visibleCatalogFieldCount.toLocaleString()} />
              <MetricCard label="RAG eligible total" value={catalog.summary.ragEligibleCount.toLocaleString()} />
            </div>
          ) : null}

          {catalog && catalog.models.length > 0 ? (
            <DataCatalogExplorer
              catalog={catalog}
              expandedModels={expandedCatalogModels}
              onToggleModel={toggleCatalogModel}
              onToggleAll={toggleAllCatalogModels}
            />
          ) : null}
          {!sectionLoading && catalog?.models.length === 0 ? (
            <Card padding="lg" className="text-sm text-slate-600">No schema fields matched these filters.</Card>
          ) : null}
        </section>
      ) : null}

      {!loading && tab === "permissions" ? (
        <PermissionsPanel policy={permissions} loading={sectionLoading} onRefresh={() => void loadPermissions()} />
      ) : null}

      {!loading && tab === "validation" ? (
        <ValidationPanel
          liveValidation={summary?.liveValidation ?? null}
          runs={validationRuns}
          loading={sectionLoading}
          running={validationRunning}
          onRun={() => void runValidation()}
          onRefresh={() => void loadValidationRuns()}
        />
      ) : null}

      {!loading && tab === "audit" ? (
        <AuditPanel events={auditEvents} loading={sectionLoading} onRefresh={() => void loadAuditEvents()} />
      ) : null}
    </div>
  );
}

function OverviewPanel({
  summary,
  ragIndex,
  onRefresh,
}: {
  summary: InternalControlPlaneSummary | null;
  ragIndex: InternalRagIndexSummary | null;
  onRefresh: () => void;
}) {
  if (!summary) return <Card padding="lg" className="text-sm text-slate-600">No platform summary is available.</Card>;
  const valid = summary.liveValidation.status === "PASSED";
  return (
    <section className="space-y-4" aria-labelledby="overview-panel-title">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Active tenants" value={summary.totals.activeTenants.toLocaleString()} />
        <MetricCard label="Active users" value={summary.totals.activeUsers.toLocaleString()} />
        <MetricCard label="Active customers" value={summary.totals.activeCustomers.toLocaleString()} />
        <MetricCard label="Active quotes" value={summary.totals.activeQuotes.toLocaleString()} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card variant="elevated" padding="lg">
          <CardHeader title="Schema governance" subtitle={`Policy ${summary.liveValidation.policyVersion}`} actions={<Button variant="outline" size="sm" icon={<RefreshCw size={15} />} onClick={onRefresh}>Refresh</Button>} />
          <div className={`rounded-xl border p-4 ${valid ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
            <div className="flex items-center gap-2">
              {valid ? <CheckCircle2 className="text-emerald-600" size={20} /> : <AlertTriangle className="text-red-600" size={20} />}
              <p className="font-semibold text-slate-900">{valid ? "Schema matches reviewed baseline" : "Schema review is required"}</p>
            </div>
            <p className="mt-2 text-sm text-slate-700">{summary.liveValidation.modelCount} models · {summary.liveValidation.fieldCount} fields · {summary.liveValidation.issueCount} issues</p>
            <p className="mt-2 break-all font-mono text-[11px] text-slate-500">{summary.liveValidation.schemaHash}</p>
          </div>
        </Card>
        <Card variant="elevated" padding="lg">
          <CardHeader title="AI platform activity" subtitle={`Configured model: ${summary.configuredAiModel}`} />
          <div className="grid grid-cols-2 gap-3">
            <MetricCompact label="Runs" value={summary.totals.aiRuns.toLocaleString()} />
            <MetricCompact label="Tokens" value={summary.totals.aiTokens.toLocaleString()} />
            <MetricCompact label="Estimated spend" value={`$${summary.totals.aiSpendUsd.toFixed(2)}`} />
            <MetricCompact label="Observed models" value={summary.observedModels.length.toLocaleString()} />
          </div>
        </Card>
      </div>
      <Card variant="elevated" padding="lg">
        <CardHeader
          title="RAG retrieval index"
          subtitle={ragIndex
            ? `${ragIndex.rollout.mode} · ${ragIndex.rollout.enabledActiveTenantCount} enabled · ${ragIndex.rollout.exposedActiveTenantCount} exposed`
            : "No indexed retrieval chunks yet"}
          actions={<Button variant="outline" size="sm" icon={<RefreshCw size={15} />} onClick={onRefresh}>Refresh</Button>}
        />
        {ragIndex ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
            <div className="grid grid-cols-2 gap-3">
              <MetricCompact label="Active docs" value={ragIndex.totals.activeDocuments.toLocaleString()} />
              <MetricCompact label="Retired docs" value={ragIndex.totals.deletedDocuments.toLocaleString()} />
              <MetricCompact label="Active chunks" value={ragIndex.totals.activeChunks.toLocaleString()} />
              <MetricCompact label="Retired chunks" value={ragIndex.totals.deletedChunks.toLocaleString()} />
              <MetricCompact label="Enabled jobs pending" value={(ragIndex.indexingQueue.jobsByStatus.PENDING ?? 0).toLocaleString()} />
              <MetricCompact label="Enabled jobs failed" value={(ragIndex.indexingQueue.jobsByStatus.DEAD ?? 0).toLocaleString()} />
              <MetricCompact
                label="Embedding cache"
                value={ragIndex.indexingQueue.embeddingCacheHitRate === null
                  ? "No samples"
                  : `${Math.round(ragIndex.indexingQueue.embeddingCacheHitRate * 100)}%`}
              />
              <MetricCompact
                label="Average index time"
                value={ragIndex.indexingQueue.averageSuccessfulDurationMs === null
                  ? "No samples"
                  : `${Math.round(ragIndex.indexingQueue.averageSuccessfulDurationMs)} ms`}
              />
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {Object.entries(ragIndex.activeChunksByClassification).map(([classificationName, count]) => (
                  <Badge key={classificationName} tone={classificationTone(classificationName as DataClassification)}>
                    {classificationName.split("_")[0]} · {count}
                  </Badge>
                ))}
                {Object.keys(ragIndex.activeChunksByClassification).length === 0 ? (
                  <span className="text-sm text-slate-500">No active chunks have been indexed.</span>
                ) : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {ragIndex.activeChunksBySourceType.slice(0, 6).map((source) => (
                  <MetricCompact key={source.sourceType} label={source.sourceType} value={source.chunkCount.toLocaleString()} />
                ))}
              </div>
              <p className="text-xs text-slate-500">
                Latest index write: {ragIndex.latestIndexedAtUtc ? formatDate(ragIndex.latestIndexedAtUtc) : "None"}.
                {ragIndex.indexingQueue.oldestPendingAtUtc
                  ? ` Oldest enabled pending job: ${formatDate(ragIndex.indexingQueue.oldestPendingAtUtc)}.`
                  : " No enabled jobs are waiting."}
                {` Outside rollout: ${(ragIndex.indexingQueue.outOfRollout.jobsByStatus.PENDING ?? 0).toLocaleString()} pending across ${ragIndex.indexingQueue.outOfRollout.activeTenantCount.toLocaleString()} active tenants; these jobs are expected to wait while disabled.`}
                Excludes {ragIndex.fieldsExcluded.join(", ")}.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">RAG index metadata is unavailable.</p>
        )}
      </Card>
      <Alert tone="info">{summary.mutationPolicy.reason}</Alert>
    </section>
  );
}

function TenantCard({ tenant }: { tenant: InternalTenantMetadata }) {
  return (
    <Card variant="elevated" padding="md">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-slate-900">{tenant.name}</h3>
          <p className="break-all text-xs text-slate-500">{tenant.slug} · {tenant.id}</p>
        </div>
        <Badge tone={tenant.deletedAtUtc ? "red" : "emerald"}>{tenant.deletedAtUtc ? "Deleted" : "Active"}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <MetricCompact label="Users" value={tenant._count.users.toLocaleString()} />
        <MetricCompact label="Customers" value={tenant._count.customers.toLocaleString()} />
        <MetricCompact label="Quotes" value={tenant._count.quotes.toLocaleString()} />
        <MetricCompact label="Products" value={tenant._count.workPresets.toLocaleString()} />
        <MetricCompact label="AI runs" value={tenant._count.aiUsageEvents.toLocaleString()} />
        <MetricCompact label="Trade" value={readable(tenant.primaryTrade)} />
      </div>
      <div className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-600">
        <p><span className="font-medium text-slate-700">Subscription:</span> {readable(tenant.subscriptionStatus)} · {tenant.subscriptionPlanCode ?? "No paid plan"}</p>
        <p className="mt-1"><span className="font-medium text-slate-700">Created:</span> {formatDate(tenant.createdAt)}</p>
      </div>
    </Card>
  );
}

function DataCatalogExplorer({ catalog, expandedModels, onToggleModel, onToggleAll }: {
  catalog: InternalDataCatalog;
  expandedModels: ReadonlySet<string>;
  onToggleModel: (modelName: string) => void;
  onToggleAll: () => void;
}) {
  const allExpanded = catalog.models.length > 0
    && catalog.models.every((model) => expandedModels.has(model.model));

  return (
    <Card variant="elevated" padding="sm" className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-1 pb-3 sm:flex-row sm:items-center sm:justify-between sm:px-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Classification catalog</h3>
          <p className="mt-1 text-sm text-slate-600">Expand a model to inspect every field, access requirement, and retrieval decision.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggleAll}
          icon={allExpanded ? <ChevronDown className="rotate-180" size={15} /> : <ChevronDown size={15} />}
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </Button>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-slate-200 px-1 py-3 sm:flex-wrap sm:px-2" aria-label="Classification legend">
        {CLASSIFICATIONS.filter((item): item is { value: DataClassification; label: string } => Boolean(item.value)).map((item) => (
          <Badge key={item.value} tone={classificationTone(item.value)} className="shrink-0 whitespace-nowrap">
            {item.label} · {catalog.summary.classificationCounts[item.value]}
          </Badge>
        ))}
      </div>

      <div className="space-y-2 px-1 pt-3 md:hidden" role="list" aria-label="Data models">
        {catalog.models.map((model) => {
          const expanded = expandedModels.has(model.model);
          const ragEligibleCount = model.fields.filter((field) => field.ragStatus === "ELIGIBLE").length;
          return (
            <article key={model.model} className="overflow-hidden rounded-xl border border-slate-200 bg-white" role="listitem">
              <button
                type="button"
                className="flex min-h-11 w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-quotefly-blue"
                aria-expanded={expanded}
                aria-controls={`mobile-fields-${model.model}`}
                aria-label={`${expanded ? "Collapse" : "Expand"} fields for ${model.model}`}
                onClick={() => onToggleModel(model.model)}
              >
                {expanded ? <ChevronDown className="mt-0.5 shrink-0 text-slate-500" size={18} /> : <ChevronRight className="mt-0.5 shrink-0 text-slate-500" size={18} />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-semibold text-slate-900">{model.model}</span>
                  <span className="mt-0.5 block break-words text-xs text-slate-500">{model.table} · {model.fields.length} visible fields · {ragEligibleCount} RAG eligible</span>
                </span>
                <Badge tone={classificationTone(model.defaultClassification)} className="shrink-0">{model.defaultClassification.split("_")[0]}</Badge>
              </button>
              {expanded ? (
                <div id={`mobile-fields-${model.model}`} className="space-y-2 border-t border-slate-200 bg-slate-50/70 p-2" aria-label={`Fields for ${model.model}`}>
                  <p className="px-1 py-1 text-xs text-slate-600">{model.purpose} · {model.tenantScope} tenant scope</p>
                  {model.fields.map((field) => (
                    <div key={field.field} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-all text-sm font-semibold text-slate-900">{model.model}.{field.field}</p>
                          <p className="mt-0.5 text-xs text-slate-500">Column {field.column} · {field.type}{field.isList ? "[]" : ""} · {field.isRequired ? "required" : "optional"}</p>
                        </div>
                        <ClassificationBadge classification={field.classification} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <RagBadge status={field.ragStatus} />
                        {field.requiredAccess.map((access) => <Badge key={access} tone="slate">{access}</Badge>)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto pt-3 md:block">
        <table className="min-w-[900px] w-full text-sm" aria-label="Data classification models">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">Model and table</th>
              <th className="px-3 py-2.5">Tenant scope</th>
              <th className="px-3 py-2.5">Default class</th>
              <th className="px-3 py-2.5 text-right">Visible fields</th>
              <th className="px-3 py-2.5 text-right">RAG eligible</th>
              <th className="px-3 py-2.5">Review</th>
            </tr>
          </thead>
          <tbody>
            {catalog.models.map((model) => {
              const expanded = expandedModels.has(model.model);
              const ragEligibleCount = model.fields.filter((field) => field.ragStatus === "ELIGIBLE").length;
              return (
                <Fragment key={model.model}>
                  <tr className="border-b border-slate-200 bg-white align-top hover:bg-slate-50/70">
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-start gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
                        aria-expanded={expanded}
                        aria-controls={`desktop-fields-${model.model}`}
                        aria-label={`${expanded ? "Collapse" : "Expand"} fields for ${model.model}`}
                        onClick={() => onToggleModel(model.model)}
                      >
                        {expanded ? <ChevronDown className="mt-0.5 shrink-0 text-slate-500" size={18} /> : <ChevronRight className="mt-0.5 shrink-0 text-slate-500" size={18} />}
                        <span>
                          <span className="block font-semibold text-slate-900">{model.model}</span>
                          <span className="mt-0.5 block text-xs text-slate-500">{model.table}</span>
                          <span className="mt-1 block max-w-xl text-xs text-slate-600">{model.purpose}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-3 text-slate-700">{readable(model.tenantScope)}</td>
                    <td className="px-3 py-3"><ClassificationBadge classification={model.defaultClassification} /></td>
                    <td className="px-3 py-3 text-right font-medium text-slate-900">{model.fields.length}</td>
                    <td className="px-3 py-3 text-right font-medium text-slate-900">{ragEligibleCount}</td>
                    <td className="px-3 py-3"><Badge tone={model.reviewStatus === "REVIEWED" ? "blue" : "red"}>{readable(model.reviewStatus)}</Badge></td>
                  </tr>
                  {expanded ? (
                    <tr id={`desktop-fields-${model.model}`} className="border-b border-slate-200 bg-slate-50/80">
                      <td colSpan={6} className="p-3">
                        <table className="w-full table-fixed overflow-hidden rounded-lg border border-slate-200 bg-white text-xs" aria-label={`Fields for ${model.model}`}>
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-100 text-left uppercase tracking-wide text-slate-500">
                              <th className="w-[28%] px-3 py-2">Field</th>
                              <th className="w-[14%] px-3 py-2">Type</th>
                              <th className="w-[20%] px-3 py-2">Classification</th>
                              <th className="w-[14%] px-3 py-2">RAG</th>
                              <th className="w-[24%] px-3 py-2">Required access</th>
                            </tr>
                          </thead>
                          <tbody>
                            {model.fields.map((field) => (
                              <tr key={field.field} className="border-b border-slate-100 last:border-b-0">
                                <td className="px-3 py-2.5 align-top">
                                  <p className="break-all font-semibold text-slate-900">{model.model}.{field.field}</p>
                                  <p className="mt-0.5 break-all text-[11px] text-slate-500">Column {field.column}</p>
                                </td>
                                <td className="px-3 py-2.5 align-top text-slate-700">{field.type}{field.isList ? "[]" : ""}<span className="mt-0.5 block text-[11px] text-slate-500">{field.isRequired ? "Required" : "Optional"}</span></td>
                                <td className="px-3 py-2.5 align-top"><ClassificationBadge classification={field.classification} /></td>
                                <td className="px-3 py-2.5 align-top"><RagBadge status={field.ragStatus} /></td>
                                <td className="px-3 py-2.5 align-top"><div className="flex flex-wrap gap-1">{field.requiredAccess.map((access) => <Badge key={access} tone="slate">{access}</Badge>)}</div></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ClassificationBadge({ classification }: { classification: DataClassification }) {
  const prefix = classification.split("_")[0];
  return <Badge tone={classificationTone(classification)} className="whitespace-nowrap">{prefix} {readable(classification)}</Badge>;
}

function RagBadge({ status }: { status: "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED" }) {
  return (
    <Badge tone={status === "ELIGIBLE" ? "emerald" : status === "REVIEW_REQUIRED" ? "red" : "slate"} className="whitespace-nowrap">
      {status === "ELIGIBLE" ? "RAG eligible" : status === "EXCLUDED" ? "RAG excluded" : "RAG review required"}
    </Badge>
  );
}

function PermissionsPanel({ policy, loading, onRefresh }: { policy: InternalPermissionPolicy | null; loading: boolean; onRefresh: () => void }) {
  return (
    <section className="space-y-4" aria-labelledby="permissions-panel-title">
      <Card variant="elevated" padding="lg">
        <CardHeader title="Workspace role policy" subtitle="The server uses this centralized capability mapping after live membership revalidation." actions={<Button variant="outline" size="sm" loading={loading} onClick={onRefresh}>Refresh</Button>} />
        {policy ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-[680px] w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">Capability</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">Admin</th><th className="px-3 py-2">Member</th></tr>
              </thead>
              <tbody>
                {policy.capabilities.map((capability) => (
                  <tr key={capability} className="border-t border-slate-200">
                    <td className="px-3 py-2 font-medium text-slate-900">{capability}</td>
                    {(["owner", "admin", "member"] as const).map((role) => (
                      <td key={role} className="px-3 py-2">
                        {policy.roles[role].includes(capability)
                          ? <CheckCircle2 className="text-emerald-600" size={18} aria-label="Allowed" />
                          : <span className="text-slate-400" aria-label="Denied">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-600">Loading permission policy...</p>}
      </Card>
      {policy ? (
        <Card variant="elevated" padding="lg">
          <CardHeader title="Operator boundary" subtitle="Cross-tenant control-plane capabilities are separately constrained." />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(policy.operatorCapabilities).map(([capability, allowed]) => (
              <div key={capability} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm">
                <span className="break-all font-medium text-slate-700">{capability}</span>
                <Badge tone={allowed ? "blue" : "red"}>{allowed ? "Allowed" : "Disabled"}</Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function ValidationPanel({ liveValidation, runs, loading, running, onRun, onRefresh }: {
  liveValidation: InternalControlPlaneSummary["liveValidation"] | null;
  runs: InternalValidationRun[];
  loading: boolean;
  running: boolean;
  onRun: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="space-y-4" aria-labelledby="validation-panel-title">
      <Card variant="elevated" padding="lg">
        <CardHeader
          title="Schema validation"
          subtitle="Rerun after every Prisma model or field change. New data fails closed until classified and reviewed."
          actions={<><Button variant="outline" size="sm" loading={loading} onClick={onRefresh}>Refresh history</Button><Button size="sm" icon={<RefreshCw size={15} />} loading={running} onClick={onRun}>Run validation</Button></>}
        />
        {liveValidation ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCompact label="Live status" value={liveValidation.status} />
            <MetricCompact label="Models" value={liveValidation.modelCount.toLocaleString()} />
            <MetricCompact label="Fields" value={liveValidation.fieldCount.toLocaleString()} />
          </div>
        ) : null}
      </Card>
      <div className="space-y-3">
        {runs.map((run) => (
          <Card key={run.id} variant="elevated" padding="md">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">{formatDate(run.createdAt)}</p>
                <p className="mt-1 text-xs text-slate-500">Policy {run.policyVersion} · {run.modelCount} models · {run.fieldCount} fields</p>
              </div>
              <Badge tone={run.status === "PASSED" ? "emerald" : "red"}>{run.status}</Badge>
            </div>
            <p className="mt-3 break-all font-mono text-[11px] text-slate-500">Schema: {run.schemaHash}</p>
            {run.issues.length ? (
              <div className="mt-3 space-y-2">
                {run.issues.map((issue, index) => (
                  <div key={`${issue.code}-${issue.model}-${issue.field ?? "model"}-${index}`} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <span className="font-semibold">{issue.code}</span> · {issue.model}{issue.field ? `.${issue.field}` : ""}: {issue.message}
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        ))}
        {!loading && runs.length === 0 ? <Card padding="lg" className="text-sm text-slate-600">No persisted validation runs yet. Run the first validation above.</Card> : null}
      </div>
    </section>
  );
}

function AuditPanel({ events, loading, onRefresh }: { events: InternalSuperuserAuditEvent[]; loading: boolean; onRefresh: () => void }) {
  return (
    <section className="space-y-4" aria-labelledby="audit-panel-title">
      <Card variant="elevated" padding="lg">
        <CardHeader title="Operator audit history" subtitle="Content-free evidence of platform-control access. Sensitive payloads and search terms are not recorded." actions={<Button variant="outline" size="sm" loading={loading} onClick={onRefresh}>Refresh</Button>} />
      </Card>
      <div className="space-y-3">
        {events.map((event) => (
          <Card key={event.id} variant="elevated" padding="md">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-all text-sm font-semibold text-slate-900">{event.action}</p>
                <p className="mt-1 text-xs text-slate-500">{event.actorUser?.email ?? "Deleted operator"} · {formatDate(event.createdAt)}</p>
              </div>
              <Badge tone="slate">{event.targetType ?? "Platform"}</Badge>
            </div>
            {event.metadata ? <p className="mt-3 break-words rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">{JSON.stringify(event.metadata)}</p> : null}
            <p className="mt-2 break-all text-[11px] text-slate-400">Request {event.requestId}</p>
          </Card>
        ))}
        {!loading && events.length === 0 ? <Card padding="lg" className="text-sm text-slate-600">No operator audit events are available.</Card> : null}
      </div>
    </section>
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

function MetricCompact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export default SuperuserAdminPage;
