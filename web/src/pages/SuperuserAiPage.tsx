import { useEffect, useState } from "react";
import { ApiError, api, type InternalAiQualitySummary, type InternalAiQualityTenantRow } from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { Alert, Card, CardHeader, PageHeader } from "../components/ui";

export function SuperuserAiPage() {
  const [summary, setSummary] = useState<InternalAiQualitySummary | null>(null);
  const [tenants, setTenants] = useState<InternalAiQualityTenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      <PageHeader title="Superuser AI Quality" subtitle="Platform-only metrics. Not visible to tenant users." />

      {error ? (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      {summary ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Runs (30d)" value={summary.totals.totalRuns.toLocaleString()} />
          <MetricCard label="Active tenants" value={summary.totals.activeTenants.toLocaleString()} />
          <MetricCard label="Spend (30d)" value={`$${summary.totals.totalSpendUsd.toFixed(2)}`} />
          <MetricCard label="Avg cost/run" value={`$${summary.averages.spendUsdPerRun.toFixed(4)}`} />
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
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-2 py-3 text-slate-500">
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

export default SuperuserAiPage;

