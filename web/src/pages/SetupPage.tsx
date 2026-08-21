import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Hammer, Palette, Plus, RotateCcw, Ruler, Sparkles, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, ConfirmModal, Input, PageHeader, ProgressBar, Select, Textarea } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceRailCard, WorkspaceSection } from "../components/ui/workspace";
import {
  api,
  type ServiceType,
  type WorkPreset,
  type WorkPresetCategory,
  type WorkPresetUnitType,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { useLocale } from "../i18n";
import { localizedApiError } from "../lib/localized-api-error";

interface SetupPageProps {
  session?: {
    primaryTrade?: ServiceType | null;
    onboardingCompletedAtUtc?: string | null;
  } | null;
  onSetupSaved?: () => Promise<void> | void;
}

interface SetupPresetDraft {
  id: string;
  persisted?: boolean;
  catalogKey?: string | null;
  catalogCustomizedAtUtc?: string | null;
  name: string;
  description: string;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  defaultQuantity: string;
  unitCost: string;
  unitPrice: string;
  isDefault: boolean;
}

const TRADE_VALUES: ServiceType[] = ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"];
const CATEGORY_VALUES: WorkPresetCategory[] = ["SERVICE", "LABOR", "MATERIAL", "FEE"];
const UNIT_VALUES: WorkPresetUnitType[] = ["FLAT", "SQ_FT", "HOUR", "EACH"];

function normalizePresetName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function inferSquareFootPreset(presets: WorkPreset[], trade: ServiceType) {
  return presets.find((preset) => preset.serviceType === trade && preset.catalogKey === "sq_ft_base") ?? null;
}

function toPresetDraft(
  preset: WorkPreset,
  recommendedCatalogMap: Map<string, string>,
): SetupPresetDraft {
  return {
    id: preset.id,
    persisted: preset.tenantId !== "recommended",
    catalogKey: preset.catalogKey ?? recommendedCatalogMap.get(normalizePresetName(preset.name)) ?? null,
    catalogCustomizedAtUtc: preset.catalogCustomizedAtUtc ?? null,
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
    persisted: false,
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

function isStandardPresetDraft(preset: SetupPresetDraft): boolean {
  return Boolean(preset.catalogKey);
}

function SetupRailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function SetupPage({ session, onSetupSaved }: SetupPageProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
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
  const [restoreStarterValuesOpen, setRestoreStarterValuesOpen] = useState(false);

  useEffect(() => {
    setSEOMetadata({
      title: t("setup.title"),
      description: t("setup.subtitle"),
    });
  }, [t]);

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
        setError(localizedApiError(err, t, { fallbackKey: "setup.loadError" }));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadSetup();
    return () => {
      mounted = false;
    };
  }, [session?.primaryTrade, t]);

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
            catalogKey: preset.catalogKey ?? null,
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

  const completionText = session?.onboardingCompletedAtUtc ? t("setup.active") : t("setup.finish");
  const tradeOptions = supportedTrades.length > 0 ? supportedTrades : TRADE_VALUES;
  const tradeSelectOptions = tradeOptions.map((option) => ({ value: option, label: t(`domain.trade.${option}`) }));
  const categoryOptions = CATEGORY_VALUES.map((value) => ({ value, label: t(`domain.category.${value}`) }));
  const unitOptions = UNIT_VALUES.map((value) => ({ value, label: t(`domain.unit.${value}`) }));
  const formatMoney = (value: number | string) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(Number(value) || 0);

  const currentPresetSummary = useMemo(() => {
    const tradePresets = existingPresets.filter((preset) => preset.serviceType === trade);
    const source = tradePresets.length > 0 ? tradePresets : recommendedPresets;
    return [...source].sort((left, right) => {
      const leftIsStandard = Boolean(left.catalogKey);
      const rightIsStandard = Boolean(right.catalogKey);
      if (leftIsStandard !== rightIsStandard) return leftIsStandard ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [existingPresets, recommendedPresets, trade]);

  const recommendedCatalogMap = useMemo(
    () =>
      new Map(
        recommendedPresets
          .filter((preset) => preset.catalogKey)
          .map((preset) => [normalizePresetName(preset.name), preset.catalogKey ?? ""]),
      ),
    [recommendedPresets],
  );

  useEffect(() => {
    setPresetDrafts(currentPresetSummary.map((preset) => toPresetDraft(preset, recommendedCatalogMap)));
  }, [currentPresetSummary, recommendedCatalogMap]);

  const visiblePresetDrafts = useMemo(
    () => presetDrafts.filter((preset) => !(chargeBySquareFoot && preset.unitType === "SQ_FT")),
    [chargeBySquareFoot, presetDrafts],
  );

  const canSaveSetup =
    presetDrafts.length > 0 &&
    presetDrafts.every((preset) => preset.name.trim().length >= 2 && Number(preset.defaultQuantity) > 0);
  const pricingConfigured = !chargeBySquareFoot || (sqFtUnitCost.trim().length > 0 && sqFtUnitPrice.trim().length > 0);
  const setupChecklist = [
    { label: t("setup.tradeSelected"), complete: Boolean(trade) },
    { label: t("setup.pricingConfigured"), complete: pricingConfigured },
    { label: t("setup.jobsReady"), complete: canSaveSetup },
    { label: t("setup.workspaceSaved"), complete: Boolean(session?.onboardingCompletedAtUtc) },
  ];
  const completedStepCount = setupChecklist.filter((step) => step.complete).length;
  const setupProgressPercent = Math.round((completedStepCount / setupChecklist.length) * 100);
  const setupLinks = [
    { id: "setup-overview", label: t("setup.overview"), hint: t("setup.progressSnapshot") },
    { id: "setup-defaults", label: t("setup.defaults"), hint: t("setup.tradePricing") },
    { id: "setup-presets", label: t("setup.presetNav"), hint: t("setup.starterJobsHint") },
    { id: "setup-next", label: t("setup.nextSteps"), hint: t("setup.brandingQuote") },
  ];

  function resetPresetDraftsToDefaults() {
    setPresetDrafts((current) => {
      const customPresets = current.filter((preset) => !isStandardPresetDraft(preset));
      const squareFootPreset = current.find((preset) => preset.catalogKey === "sq_ft_base");
      const nextStandardPresets = recommendedPresets.map((preset) => toPresetDraft(preset, recommendedCatalogMap));
      return [...(squareFootPreset ? [squareFootPreset] : []), ...nextStandardPresets, ...customPresets];
    });
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
        setError(t("setup.presetLimit"));
        return current;
      }
      return [...current, createEmptyPresetDraft(trade, current.length)];
    });
  }

  function removePresetDraft(presetId: string) {
    setPresetDrafts((current) => current.filter((preset) => preset.id !== presetId));
  }

  async function saveSetup(nextPath?: "/app" | "/app/customers" | "/app/branding") {
    setSaving(true);
    setError(null);
    try {
      const nextSqFtCost = chargeBySquareFoot && sqFtUnitCost ? Number(sqFtUnitCost) : undefined;
      const nextSqFtPrice = chargeBySquareFoot && sqFtUnitPrice ? Number(sqFtUnitPrice) : undefined;
      const normalizedPresets = presetDrafts
        .filter((preset) => preset.name.trim().length >= 2)
        .map((preset) => ({
          id: preset.id,
          catalogKey: preset.catalogKey ?? undefined,
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
        chargeBySquareFoot,
        sqFtUnitCost: nextSqFtCost,
        sqFtUnitPrice: nextSqFtPrice,
        presets: normalizedPresets,
      });

      const refreshedSetup = await api.onboarding.getSetup();
      await onSetupSaved?.();
      setExistingPresets(refreshedSetup.presets);
      setNotice(t("setup.savedForTrade", { trade: t(`domain.trade.${trade}`) }));
      if (nextPath) navigate(nextPath);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "setup.saveError" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={session?.onboardingCompletedAtUtc ? t("setup.title") : t("setup.getReady")}
        subtitle={
          session?.onboardingCompletedAtUtc
            ? t("setup.activeSubtitle")
            : t("setup.firstSubtitle")
        }
        actions={
          session?.onboardingCompletedAtUtc ? (
            <Button variant="outline" onClick={() => navigate("/app/branding")}>
              {t("setup.branding")}
            </Button>
          ) : null
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      {!session?.onboardingCompletedAtUtc ? (
        <Card variant="blue" padding="lg" className="overflow-hidden">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-quotefly-blue">{t("setup.fast")}</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{t("setup.provenDefaults")}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                {t("setup.prepared", { count: recommendedPresets.length, trade: t(`domain.trade.${trade}`) })}
              </p>
              {!canSaveSetup && !loading ? (
                <p className="mt-2 text-xs font-medium text-amber-700">{t("setup.preparing")}</p>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[360px]">
              <Button
                size="lg"
                loading={saving}
                disabled={loading || !canSaveSetup}
                onClick={() => void saveSetup("/app")}
              >
                {t("setup.useDefaults")}
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => document.getElementById("setup-defaults")?.scrollIntoView({ behavior: "smooth" })}
              >
                {t("setup.customizeFirst")}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <WorkspaceRailCard
            eyebrow={t("pages.setup.label")}
            title={t("setup.railTitle")}
            description={t("setup.railDescription")}
          >
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <SetupRailStat label={t("setup.tradeLabel")} value={t(`domain.trade.${trade}`)} />
              <SetupRailStat label={t("setup.starterJobs")} value={String(presetDrafts.length)} />
              <SetupRailStat label={t("setup.areaPricing")} value={chargeBySquareFoot ? t("setup.enabled") : t("setup.optional")} />
            </div>
            <WorkspaceJumpBar links={setupLinks} className="mt-4" />
          </WorkspaceRailCard>

          <WorkspaceRailCard
            eyebrow={t("setup.currentState")}
            title={t("setup.percentReady", { percent: setupProgressPercent })}
            description={t("setup.itemsComplete", { complete: completedStepCount, total: setupChecklist.length })}
          >
            <ProgressBar
              value={setupProgressPercent}
              label={t("setup.completion")}
              hint={t("setup.completeHint", { complete: completedStepCount, total: setupChecklist.length })}
            />
            <div className="mt-4 grid gap-2">
              <Button onClick={() => void saveSetup()} loading={saving} disabled={!canSaveSetup} fullWidth>
                {t("setup.save")}
              </Button>
              <Button variant="outline" onClick={() => navigate("/app/branding")} fullWidth>
                {t("setup.nextBranding")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/app/build")} fullWidth>
                {t("setup.quoteBuilder")}
              </Button>
            </div>
          </WorkspaceRailCard>
        </aside>

        <div className="space-y-6">
          <WorkspaceSection
            id="setup-overview"
            step="1"
            title={t("setup.overview")}
            description={t("setup.overviewDescription")}
          >
            <Card variant="blue" padding="lg" className="overflow-hidden">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)] lg:items-center">
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-quotefly-blue">{t("setup.progress")}</p>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">{t("setup.overviewTitle")}</h2>
                    <p className="mt-2 max-w-2xl text-sm text-slate-600 sm:text-base">
                      {t("setup.overviewHelp")}
                    </p>
                  </div>

                  <ProgressBar
                    value={setupProgressPercent}
                    label={t("setup.completion")}
                    hint={t("setup.completeHint", { complete: completedStepCount, total: setupChecklist.length })}
                  />

                  <div className="flex flex-wrap gap-2">
                    {setupChecklist.map((step) => (
                      <span
                        key={step.label}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                          step.complete
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                            : "border-slate-300 bg-white/85 text-slate-600"
                        }`}
                      >
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/90">
                          {step.complete ? <Check size={12} /> : <span className="h-2 w-2 rounded-full bg-current" />}
                        </span>
                        {step.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="rounded-[26px] border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("setup.snapshot")}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("setup.primaryTrade")}</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{t(`domain.trade.${trade}`)}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("setup.starterJobs")}</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{presetDrafts.length}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("setup.areaPricing")}</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{chargeBySquareFoot ? t("setup.enabled") : t("setup.optional")}</p>
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card variant="blue">
                <CardHeader title={t("setup.tradeFocus")} subtitle={t("setup.tradeFocusSubtitle")} />
                <p className="text-2xl font-semibold text-slate-900">{t(`domain.trade.${trade}`)}</p>
                <p className="mt-1 text-sm text-slate-600">{t("setup.tradeFocusHelp")}</p>
              </Card>
              <Card>
                <CardHeader title={t("setup.presetPack")} subtitle={t("setup.presetPackSubtitle")} />
                <p className="text-2xl font-semibold text-slate-900">{recommendedPresets.length}</p>
                <p className="mt-1 text-sm text-slate-600">{t("setup.presetPackHelp")}</p>
              </Card>
              <Card>
                <CardHeader title={t("setup.status")} subtitle={t("setup.workspaceReadiness")} />
                <Badge tone={session?.onboardingCompletedAtUtc ? "emerald" : "amber"}>{completionText}</Badge>
                <p className="mt-3 text-sm text-slate-600">
                  {t("setup.finishHelp")}
                </p>
              </Card>
            </div>
          </WorkspaceSection>

          <WorkspaceSection
            id="setup-defaults"
            step="2"
            title={t("setup.tradeDefaults")}
            description={t("setup.tradeDefaultsDescription")}
          >
            <Card variant="elevated">
          <CardHeader
            title={t("setup.tradeDefaults")}
            subtitle={t("setup.tradeDefaultsDescription")}
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
                  <label className="mb-1 block text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{t("setup.primaryTrade")}</label>
                  <Select value={trade} onChange={(event) => setTrade(event.target.value as ServiceType)} options={tradeSelectOptions} />
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{t("setup.recommendedPresets")}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{recommendedPresets.length}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-amber-600 shadow-sm">
                    <Ruler size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{t("setup.squareFootTitle")}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {t("setup.squareFootHelp")}
                    </p>
                    <label className="mt-3 flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm text-slate-700 outline-none transition focus-within:bg-white focus-within:ring-2 focus-within:ring-quotefly-blue/40">
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 rounded border-slate-300 text-quotefly-blue focus-visible:outline-none"
                        checked={chargeBySquareFoot}
                        onChange={(event) => setChargeBySquareFoot(event.target.checked)}
                      />
                      {t("setup.enableSquareFoot")}
                    </label>
                  </div>
                </div>

                {chargeBySquareFoot ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <Input
                      label={t("setup.costPrivacy")}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={sqFtUnitCost}
                      onChange={(event) => setSqFtUnitCost(event.target.value)}
                    />
                    <Input
                      label={t("setup.unitPrice")}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={sqFtUnitPrice}
                      onChange={(event) => setSqFtUnitPrice(event.target.value)}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void saveSetup()} loading={saving} disabled={!canSaveSetup}>
                  {t("setup.save")}
                </Button>
                <Button variant="outline" onClick={() => navigate("/app/branding")}>
                  {t("setup.nextBranding")}
                </Button>
                <Button variant="ghost" onClick={() => navigate("/app/build")}>
                  {t("setup.goBuilder")}
                </Button>
              </div>
            </div>
          )}
            </Card>
          </WorkspaceSection>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <WorkspaceSection
              id="setup-presets"
              step="3"
              title={t("setup.presetBuilder")}
              description={t("setup.presetBuilderDescription", { trade: t(`domain.trade.${trade}`) })}
            >
              <Card>
            <CardHeader
              title={t("setup.presetBuilder")}
              subtitle={t("setup.presetBuilderDescription", { trade: t(`domain.trade.${trade}`) })}
              actions={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRestoreStarterValuesOpen(true)}>
                    <RotateCcw size={14} />
                    {t("setup.restore")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={addPresetDraft}>
                    <Plus size={14} />
                    {t("setup.addPreset")}
                  </Button>
                </div>
              }
            />
            <div className="space-y-3">
              {chargeBySquareFoot ? (
                <Alert tone="info">
                  {t("setup.squareFootManaged")}
                </Alert>
              ) : null}

              {visiblePresetDrafts.length === 0 ? (
                <Alert tone="warning">{t("setup.addAtLeastOne")}</Alert>
              ) : null}

              {visiblePresetDrafts.map((preset, index) => (
                <div key={preset.id} className="rounded-xl border border-slate-200 p-3">
                  {isStandardPresetDraft(preset) ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <Badge tone={preset.catalogCustomizedAtUtc ? "amber" : "blue"}>{preset.catalogCustomizedAtUtc ? t("setup.starterCustomized") : t("setup.standard")}</Badge>
                      <span>{t("setup.starterSavedHelp")}</span>
                    </div>
                  ) : (
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <Badge tone="slate">{t("setup.yourItem")}</Badge>
                      <span>{preset.persisted ? t("setup.tenantSavedHelp") : t("setup.draftHelp")}</span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{t("setup.presetNumber", { number: index + 1 })}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {t("setup.presetHelp")}
                      </p>
                    </div>
                    {isStandardPresetDraft(preset) ? null : preset.persisted ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => navigate("/app/products")}
                      >
                        {t("setup.manageProducts")}
                      </Button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => removePresetDraft(preset.id)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 outline-none transition hover:bg-slate-50 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-quotefly-blue/50 focus-visible:ring-offset-2"
                        aria-label={t("setup.removePreset", { number: index + 1 })}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>

                  <div className="mt-3 grid gap-3">
                    <Input
                      label={t("setup.lineTitle")}
                      value={preset.name}
                      disabled={isStandardPresetDraft(preset)}
                      onChange={(event) => updatePresetDraft(preset.id, "name", event.target.value)}
                      placeholder={t("setup.lineTitle")}
                    />
                    <Textarea
                      label={t("setup.lineDescription")}
                      value={preset.description}
                      onChange={(event) => updatePresetDraft(preset.id, "description", event.target.value)}
                      placeholder={t("setup.lineDescriptionPlaceholder")}
                      rows={3}
                    />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Select
                        label={t("setup.category")}
                        value={preset.category}
                        disabled={isStandardPresetDraft(preset)}
                        onChange={(event) => updatePresetDraft(preset.id, "category", event.target.value as WorkPresetCategory)}
                        options={categoryOptions}
                      />
                      <Select
                        label={t("setup.unitType")}
                        value={preset.unitType}
                        disabled={isStandardPresetDraft(preset)}
                        onChange={(event) => updatePresetDraft(preset.id, "unitType", event.target.value as WorkPresetUnitType)}
                        options={unitOptions}
                      />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <Input
                        label={t("setup.defaultQty")}
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={preset.defaultQuantity}
                        onChange={(event) => updatePresetDraft(preset.id, "defaultQuantity", event.target.value)}
                        placeholder={t("setup.quantity")}
                      />
                      <Input
                        label={t("products.editor.cost")}
                        type="number"
                        min="0"
                        step="0.01"
                        value={preset.unitCost}
                        onChange={(event) => updatePresetDraft(preset.id, "unitCost", event.target.value)}
                        placeholder={t("setup.cost")}
                      />
                      <Input
                        label={t("products.editor.price")}
                        type="number"
                        min="0"
                        step="0.01"
                        value={preset.unitPrice}
                        onChange={(event) => updatePresetDraft(preset.id, "unitPrice", event.target.value)}
                        placeholder={t("setup.price")}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <Badge tone="slate">{t(`domain.unit.${preset.unitType}`)}</Badge>
                      <span className="rounded-full bg-slate-100 px-2 py-1">{t("setup.qty", { quantity: preset.defaultQuantity || "0" })}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">{t("setup.costAmount", { amount: formatMoney(preset.unitCost) })}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">{t("setup.priceAmount", { amount: formatMoney(preset.unitPrice) })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
              </Card>
            </WorkspaceSection>

            <WorkspaceSection
              id="setup-next"
              step="4"
              title={t("setup.nextSteps")}
              description={t("setup.nextStepsDescription")}
            >
              <Card>
                <CardHeader title={t("setup.recommendedNext")} subtitle={t("setup.recommendedNextSubtitle")} />
                <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                  <Palette size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">{t("setup.finalizeBranding")}</p>
                  <p className="mt-1 text-sm text-slate-600">{t("setup.finalizeBrandingHelp")}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-50 text-orange-700">
                  <Hammer size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">{t("setup.firstCustomer")}</p>
                  <p className="mt-1 text-sm text-slate-600">{t("setup.firstCustomerHelp")}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
                  <Sparkles size={18} />
                </div>
                <div>
                  <p className="font-medium text-slate-900">{t("setup.chatQuote")}</p>
                  <p className="mt-1 text-sm text-slate-600">{t("setup.chatQuoteHelp")}</p>
                </div>
              </div>
              <Button variant="outline" fullWidth onClick={() => navigate("/app/branding")}>
                {t("setup.continueBranding")}
                <ChevronRight size={16} />
              </Button>
                </div>
              </Card>
            </WorkspaceSection>
          </div>
        </div>
      </div>
      <ConfirmModal
        open={restoreStarterValuesOpen}
        onClose={() => setRestoreStarterValuesOpen(false)}
        onConfirm={() => {
          resetPresetDraftsToDefaults();
          setRestoreStarterValuesOpen(false);
        }}
        title={t("setup.restoreDraftTitle")}
        description={t("setup.restoreDraftDescription")}
        confirmLabel={t("setup.restoreDraftConfirm")}
        confirmVariant="warning"
      />
    </div>
  );
}
