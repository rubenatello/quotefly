import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Hammer, Palette, Plus, RotateCcw, Ruler, Sparkles, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Input, PageHeader, Select } from "../components/ui";
import {
  ApiError,
  api,
  type ServiceType,
  type WorkPreset,
  type WorkPresetCategory,
  type WorkPresetUnitType,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";

interface SetupPageProps {
  session?: {
    primaryTrade?: ServiceType | null;
    onboardingCompletedAtUtc?: string | null;
  } | null;
  onSetupSaved?: () => Promise<void> | void;
}

interface SetupPresetDraft {
  id: string;
  name: string;
  description: string;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  defaultQuantity: string;
  unitCost: string;
  unitPrice: string;
  isDefault: boolean;
}

const TRADE_LABELS: Record<ServiceType, string> = {
  HVAC: "HVAC",
  PLUMBING: "Plumbing",
  FLOORING: "Flooring",
  ROOFING: "Roofing",
  GARDENING: "Gardening",
  CONSTRUCTION: "Construction",
};

const PRESET_CATEGORY_OPTIONS: Array<{ value: WorkPresetCategory; label: string }> = [
  { value: "SERVICE", label: "Service" },
  { value: "LABOR", label: "Labor" },
  { value: "MATERIAL", label: "Material" },
  { value: "FEE", label: "Fee" },
];

const PRESET_UNIT_OPTIONS: Array<{ value: WorkPresetUnitType; label: string }> = [
  { value: "FLAT", label: "Flat" },
  { value: "SQ_FT", label: "SQ FT" },
  { value: "HOUR", label: "Hour" },
  { value: "EACH", label: "Each" },
];

function formatUnitType(value: WorkPreset["unitType"]): string {
  if (value === "SQ_FT") return "SQ FT";
  if (value === "HOUR") return "Hour";
  if (value === "EACH") return "Each";
  return "Flat";
}

function inferSquareFootPreset(presets: WorkPreset[], trade: ServiceType) {
  return presets.find((preset) => preset.serviceType === trade && preset.unitType === "SQ_FT") ?? null;
}

function toPresetDraft(preset: WorkPreset): SetupPresetDraft {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description ?? "",
    category: preset.category,
    unitType: preset.unitType,
    defaultQuantity: String(Number(preset.defaultQuantity)),
    unitCost: String(Number(preset.unitCost)),
    unitPrice: String(Number(preset.unitPrice)),
    isDefault: preset.isDefault,
  };
}

function createEmptyPresetDraft(trade: ServiceType, index: number): SetupPresetDraft {
  return {
    id: `custom-${trade}-${Date.now()}-${index}`,
    name: "",
    description: "",
    category: "SERVICE",
    unitType: "FLAT",
    defaultQuantity: "1",
    unitCost: "0",
    unitPrice: "0",
    isDefault: true,
  };
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
  const [presetDrafts, setPresetDrafts] = useState<SetupPresetDraft[]>([]);
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

  useEffect(() => {
    setPresetDrafts(currentPresetSummary.map(toPresetDraft));
  }, [currentPresetSummary]);

  const visiblePresetDrafts = useMemo(
    () => presetDrafts.filter((preset) => !(chargeBySquareFoot && preset.unitType === "SQ_FT")),
    [chargeBySquareFoot, presetDrafts],
  );

  const canSaveSetup =
    presetDrafts.length > 0 &&
    presetDrafts.every((preset) => preset.name.trim().length >= 2 && Number(preset.defaultQuantity) > 0);

  function resetPresetDraftsToDefaults() {
    setPresetDrafts(recommendedPresets.map(toPresetDraft));
  }

  function updatePresetDraft(
    presetId: string,
    field: keyof SetupPresetDraft,
    value: string | boolean,
  ) {
    setPresetDrafts((current) =>
      current.map((preset) => (preset.id === presetId ? { ...preset, [field]: value } : preset)),
    );
  }

  function addPresetDraft() {
    setPresetDrafts((current) => {
      if (current.length >= 50) {
        setError("Preset setup is limited to 50 items.");
        return current;
      }
      return [...current, createEmptyPresetDraft(trade, current.length)];
    });
  }

  function removePresetDraft(presetId: string) {
    setPresetDrafts((current) => current.filter((preset) => preset.id !== presetId));
  }

  async function saveSetup() {
    setSaving(true);
    setError(null);
    try {
      const nextSqFtCost = chargeBySquareFoot && sqFtUnitCost ? Number(sqFtUnitCost) : undefined;
      const nextSqFtPrice = chargeBySquareFoot && sqFtUnitPrice ? Number(sqFtUnitPrice) : undefined;
      const normalizedPresets = presetDrafts
        .filter((preset) => preset.name.trim().length >= 2)
        .map((preset) => ({
          name: preset.name.trim(),
          description: preset.description.trim() || undefined,
          category: preset.category,
          unitType: preset.unitType,
          defaultQuantity: Number(preset.defaultQuantity || "0"),
          unitCost: Number(preset.unitCost || "0"),
          unitPrice: Number(preset.unitPrice || "0"),
          isDefault: preset.isDefault,
        }));

      await api.onboarding.saveSetup({
        primaryTrade: trade,
        generateLogoIfMissing: true,
        chargeBySquareFoot,
        sqFtUnitCost: nextSqFtCost,
        sqFtUnitPrice: nextSqFtPrice,
        presets: normalizedPresets,
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
                <Button onClick={() => void saveSetup()} loading={saving} disabled={!canSaveSetup}>
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
              title="Preset Builder"
              subtitle={`Edit the starter pricing pack for ${TRADE_LABELS[trade]} before your crew starts quoting.`}
              actions={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={resetPresetDraftsToDefaults}>
                    <RotateCcw size={14} />
                    Reset
                  </Button>
                  <Button size="sm" variant="outline" onClick={addPresetDraft}>
                    <Plus size={14} />
                    Add
                  </Button>
                </div>
              }
            />
            <div className="space-y-3">
              {chargeBySquareFoot ? (
                <Alert tone="info">
                  Square-foot baseline pricing is managed above. Custom SQ FT presets created by setup are hidden here to avoid duplicate edits.
                </Alert>
              ) : null}

              {visiblePresetDrafts.length === 0 ? (
                <Alert tone="warning">Add at least one preset before saving setup.</Alert>
              ) : null}

              {visiblePresetDrafts.map((preset, index) => (
                <div key={preset.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">Preset {index + 1}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        This becomes a reusable starting line in quote creation.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removePresetDraft(preset.id)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      aria-label={`Remove preset ${index + 1}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  <div className="mt-3 grid gap-3">
                    <Input
                      value={preset.name}
                      onChange={(event) => updatePresetDraft(preset.id, "name", event.target.value)}
                      placeholder="Preset name"
                    />
                    <Input
                      value={preset.description}
                      onChange={(event) => updatePresetDraft(preset.id, "description", event.target.value)}
                      placeholder="Description (optional)"
                    />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Select
                        value={preset.category}
                        onChange={(event) => updatePresetDraft(preset.id, "category", event.target.value as WorkPresetCategory)}
                        options={PRESET_CATEGORY_OPTIONS}
                      />
                      <Select
                        value={preset.unitType}
                        onChange={(event) => updatePresetDraft(preset.id, "unitType", event.target.value as WorkPresetUnitType)}
                        options={PRESET_UNIT_OPTIONS}
                      />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={preset.defaultQuantity}
                        onChange={(event) => updatePresetDraft(preset.id, "defaultQuantity", event.target.value)}
                        placeholder="Qty"
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={preset.unitCost}
                        onChange={(event) => updatePresetDraft(preset.id, "unitCost", event.target.value)}
                        placeholder="Unit cost"
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={preset.unitPrice}
                        onChange={(event) => updatePresetDraft(preset.id, "unitPrice", event.target.value)}
                        placeholder="Unit price"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <Badge tone="slate">{formatUnitType(preset.unitType)}</Badge>
                      <span className="rounded-full bg-slate-100 px-2 py-1">Qty {preset.defaultQuantity || "0"}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">Cost ${Number(preset.unitCost || 0).toFixed(2)}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">Price ${Number(preset.unitPrice || 0).toFixed(2)}</span>
                    </div>
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
