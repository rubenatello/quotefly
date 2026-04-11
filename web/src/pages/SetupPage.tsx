import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Hammer, Palette, Ruler, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Input, PageHeader, Select } from "../components/ui";
import { ApiError, api, type ServiceType, type WorkPreset } from "../lib/api";
import { setSEOMetadata } from "../lib/seo";

interface SetupPageProps {
  session?: {
    primaryTrade?: ServiceType | null;
    onboardingCompletedAtUtc?: string | null;
  } | null;
  onSetupSaved?: () => Promise<void> | void;
}

const TRADE_LABELS: Record<ServiceType, string> = {
  HVAC: "HVAC",
  PLUMBING: "Plumbing",
  FLOORING: "Flooring",
  ROOFING: "Roofing",
  GARDENING: "Gardening",
  CONSTRUCTION: "Construction",
};

function formatUnitType(value: WorkPreset["unitType"]): string {
  if (value === "SQ_FT") return "SQ FT";
  if (value === "HOUR") return "Hour";
  if (value === "EACH") return "Each";
  return "Flat";
}

function inferSquareFootPreset(presets: WorkPreset[], trade: ServiceType) {
  return presets.find((preset) => preset.serviceType === trade && preset.unitType === "SQ_FT") ?? null;
}

export function SetupPage({ session, onSetupSaved }: SetupPageProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trade, setTrade] = useState<ServiceType>(session?.primaryTrade ?? "ROOFING");
  const [supportedTrades, setSupportedTrades] = useState<ServiceType[]>([]);
  const [recommendedPresets, setRecommendedPresets] = useState<WorkPreset[]>([]);
  const [existingPresets, setExistingPresets] = useState<WorkPreset[]>([]);
  const [chargeBySquareFoot, setChargeBySquareFoot] = useState(false);
  const [sqFtUnitCost, setSqFtUnitCost] = useState("");
  const [sqFtUnitPrice, setSqFtUnitPrice] = useState("");

  useEffect(() => {
    setSEOMetadata({
      title: "Workspace Setup",
      description: "Configure trade defaults, baseline pricing, and recommended presets for your QuoteFly workspace.",
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadSetup() {
      setLoading(true);
      setError(null);
      try {
        const result = await api.onboarding.getSetup();
        if (!mounted) return;

        const nextTrade = result.tenant.primaryTrade ?? session?.primaryTrade ?? result.supportedTrades[0] ?? "ROOFING";
        const currentPresets = result.presets.filter((preset) => preset.serviceType === nextTrade);
        const sqFtPreset = inferSquareFootPreset(currentPresets, nextTrade);

        setTrade(nextTrade);
        setSupportedTrades(result.supportedTrades);
        setExistingPresets(result.presets);
        setChargeBySquareFoot(Boolean(sqFtPreset));
        setSqFtUnitCost(sqFtPreset ? String(Number(sqFtPreset.unitCost)) : "");
        setSqFtUnitPrice(sqFtPreset ? String(Number(sqFtPreset.unitPrice)) : "");
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof ApiError ? err.message : "Failed loading setup.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadSetup();
    return () => {
      mounted = false;
    };
  }, [session?.primaryTrade]);

  useEffect(() => {
    let mounted = true;
    api.onboarding
      .getRecommendedPresets(trade)
      .then((result) => {
        if (!mounted) return;
        setRecommendedPresets(
          result.presets.map((preset, index) => ({
            id: `recommended-${trade}-${index}`,
            tenantId: "recommended",
            serviceType: result.serviceType,
            category: preset.category,
            unitType: preset.unitType,
            name: preset.name,
            description: preset.description,
            defaultQuantity: preset.defaultQuantity,
            unitCost: preset.unitCost,
            unitPrice: preset.unitPrice,
            isDefault: preset.isDefault ?? true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })),
        );
      })
      .catch(() => {
        if (mounted) setRecommendedPresets([]);
      });

    return () => {
      mounted = false;
    };
  }, [trade]);

  const completionText = session?.onboardingCompletedAtUtc ? "Setup active" : "Finish setup";
  const tradeOptions = supportedTrades.length > 0 ? supportedTrades : (Object.keys(TRADE_LABELS) as ServiceType[]);
  const tradeSelectOptions = tradeOptions.map((option) => ({ value: option, label: TRADE_LABELS[option] }));

  const currentPresetSummary = useMemo(() => {
    const tradePresets = existingPresets.filter((preset) => preset.serviceType === trade);
    if (tradePresets.length > 0) return tradePresets;
    return recommendedPresets;
  }, [existingPresets, recommendedPresets, trade]);

  async function saveSetup() {
    setSaving(true);
    setError(null);
    try {
      const nextSqFtCost = chargeBySquareFoot && sqFtUnitCost ? Number(sqFtUnitCost) : undefined;
      const nextSqFtPrice = chargeBySquareFoot && sqFtUnitPrice ? Number(sqFtUnitPrice) : undefined;

      await api.onboarding.saveSetup({
        primaryTrade: trade,
        generateLogoIfMissing: true,
        chargeBySquareFoot,
        sqFtUnitCost: nextSqFtCost,
        sqFtUnitPrice: nextSqFtPrice,
      });

      const refreshedSetup = await api.onboarding.getSetup();
      await onSetupSaved?.();
      setExistingPresets(refreshedSetup.presets);
      setNotice(`Setup saved for ${TRADE_LABELS[trade]}. Pricing defaults and presets are ready.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed saving setup.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workspace Setup"
        subtitle="Set the trade, pricing model, and starter presets your crew will use to quote quickly."
        actions={
          <Button variant="outline" onClick={() => navigate("/app/branding")}>
            Branding
          </Button>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card variant="blue">
          <CardHeader title="Trade Focus" subtitle="Primary service type used for defaults" />
          <p className="text-2xl font-semibold text-slate-900">{TRADE_LABELS[trade]}</p>
          <p className="mt-1 text-sm text-slate-600">This drives pricing defaults, presets, and faster quote creation.</p>
        </Card>
        <Card>
          <CardHeader title="Preset Pack" subtitle="Jobs and line items ready to start from" />
          <p className="text-2xl font-semibold text-slate-900">{recommendedPresets.length}</p>
          <p className="mt-1 text-sm text-slate-600">Recommended presets will be saved or refreshed for the selected trade.</p>
        </Card>
        <Card>
          <CardHeader title="Status" subtitle="Workspace readiness" />
          <Badge tone={session?.onboardingCompletedAtUtc ? "emerald" : "amber"}>{completionText}</Badge>
          <p className="mt-3 text-sm text-slate-600">
            Finish setup here, then move to branding and quote creation.
          </p>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card variant="elevated">
          <CardHeader
            title="Trade Defaults"
            subtitle="Choose your core trade and optionally set a square-foot baseline."
          />
          {loading ? (
            <div className="space-y-3">
              <div className="h-11 animate-pulse rounded-xl bg-slate-200" />
              <div className="h-11 animate-pulse rounded-xl bg-slate-200" />
              <div className="h-32 animate-pulse rounded-xl bg-slate-200" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Primary Trade</label>
                  <Select value={trade} onChange={(event) => setTrade(event.target.value as ServiceType)} options={tradeSelectOptions} />
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Recommended Presets</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{recommendedPresets.length}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-amber-600 shadow-sm">
                    <Ruler size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">Square-Foot Pricing</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Use this when jobs are commonly estimated by area, like roofing or flooring.
                    </p>
                    <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={chargeBySquareFoot}
                        onChange={(event) => setChargeBySquareFoot(event.target.checked)}
                      />
                      Enable square-foot baseline pricing
                    </label>
                  </div>
                </div>

                {chargeBySquareFoot ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="SQ FT internal cost"
                      value={sqFtUnitCost}
                      onChange={(event) => setSqFtUnitCost(event.target.value)}
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="SQ FT customer price"
                      value={sqFtUnitPrice}
                      onChange={(event) => setSqFtUnitPrice(event.target.value)}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void saveSetup()} loading={saving}>
                  Save Setup
                </Button>
                <Button variant="outline" onClick={() => navigate("/app/branding")}>
                  Next: Branding
                </Button>
                <Button variant="ghost" onClick={() => navigate("/app/build")}>
                  Go to Quote Builder
                </Button>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Preset Preview"
              subtitle={`What ${TRADE_LABELS[trade]} users will start with after setup is saved.`}
            />
            <div className="space-y-3">
              {currentPresetSummary.slice(0, 6).map((preset) => (
                <div key={preset.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{preset.name}</p>
                      {preset.description ? <p className="mt-1 text-xs text-slate-500">{preset.description}</p> : null}
                    </div>
                    <Badge tone="slate">{formatUnitType(preset.unitType)}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="rounded-full bg-slate-100 px-2 py-1">Qty {Number(preset.defaultQuantity)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">Cost ${Number(preset.unitCost).toFixed(2)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-1">Price ${Number(preset.unitPrice).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Recommended Next Steps" subtitle="Keep the first-run flow short and useful." />
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                  <Palette size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">Finalize branding</p>
                  <p className="mt-1 text-sm text-slate-600">Upload the logo, confirm business info, and choose the PDF template.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-50 text-orange-700">
                  <Hammer size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">Create the first customer</p>
                  <p className="mt-1 text-sm text-slate-600">Start with one real lead so the pipeline and quote flow feel concrete.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
                  <Sparkles size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">Use Chat to Quote</p>
                  <p className="mt-1 text-sm text-slate-600">Once trade defaults exist, AI quote drafts become materially more useful.</p>
                </div>
              </div>
              <Button variant="outline" fullWidth onClick={() => navigate("/app/branding")}>
                Continue to Branding
                <ArrowRight size={16} />
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
