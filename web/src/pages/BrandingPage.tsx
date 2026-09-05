import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Eye,
  ImageIcon,
  Palette,
  RefreshCw,
  SwatchBook,
  Upload,
} from "lucide-react";
import { setSEOMetadata } from "../lib/seo";
import i18n from "../i18n/i18n";
import { QUOTE_MESSAGE_TEMPLATE_TOKENS } from "../lib/quote-message-template";
import {
  api,
  type BrandingBusinessProfile,
  type BrandingComponentColors,
  type BrandingLogoPosition,
  type PlanCode,
  type SupportedLocale,
} from "../lib/api";
import { isSupportedBrandLogoDataUrl, resizeBrandLogoFile } from "../lib/brand-logo";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { Badge, Button, ConfirmModal, Input, LoadingState, PageHeader, ProgressBar, Select, Textarea, WorkflowActionDock } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceRailCard } from "../components/ui/workspace";
import { BrandingSectionCard, BrandingSummaryTile } from "../components/branding/BrandingSectionCard";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
import { BrandQuickSetup } from "../components/branding/BrandQuickSetup";
import { buildQuoteFooterText, shouldShowQuoteFlyAttribution } from "../components/quotes/quote-footer";
import {
  QUOTE_TEMPLATE_OPTIONS,
  getQuoteTemplateOption,
  normalizeQuoteTemplateId,
  type QuoteTemplateOption,
  type StandardQuoteTemplateId,
} from "../components/quotes/quote-template";

interface BrandingPageProps {
  tenantId?: string;
  effectivePlanCode?: PlanCode;
}

type BrandingSectionId = "business" | "logo" | "colors" | "templates" | "preview";

interface BrandingSectionConfig {
  id: BrandingSectionId;
  title: string;
  description: string;
  icon: LucideIcon;
}

interface LogoPositionOption {
  value: BrandingLogoPosition;
  label: string;
  description: string;
  icon: LucideIcon;
}

const EMPTY_BUSINESS_PROFILE: BrandingBusinessProfile = {
  businessEmail: "",
  businessPhone: "",
  quoteMessageTemplate: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
};

const FALLBACK_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

function colorComponents(t: TFunction): Array<{ key: keyof BrandingComponentColors; label: string; description: string }> {
  return [
    { key: "headerBgColor", label: t("branding.colors.components.headerBg.label"), description: t("branding.colors.components.headerBg.description") },
    { key: "sectionTitleColor", label: t("branding.colors.components.sectionTitle.label"), description: t("branding.colors.components.sectionTitle.description") },
    { key: "tableHeaderBgColor", label: t("branding.colors.components.tableHeader.label"), description: t("branding.colors.components.tableHeader.description") },
    { key: "tableHeaderTextColor", label: t("branding.colors.components.tableText.label"), description: t("branding.colors.components.tableText.description") },
    { key: "totalsColor", label: t("branding.colors.components.totals.label"), description: t("branding.colors.components.totals.description") },
    { key: "footerTextColor", label: t("branding.colors.components.footerText.label"), description: t("branding.colors.components.footerText.description") },
  ];
}

function logoPositionOptions(t: TFunction): LogoPositionOption[] {
  return [
  {
    value: "left",
    label: t("branding.logoSection.positions.left.label"),
    description: t("branding.logoSection.positions.left.description"),
    icon: AlignLeft,
  },
  {
    value: "center",
    label: t("branding.logoSection.positions.center.label"),
    description: t("branding.logoSection.positions.center.description"),
    icon: AlignCenter,
  },
  {
    value: "right",
    label: t("branding.logoSection.positions.right.label"),
    description: t("branding.logoSection.positions.right.description"),
    icon: AlignRight,
  },
  ];
}

function brandingSections(t: TFunction): BrandingSectionConfig[] {
  return [
  {
    id: "business",
    title: t("branding.sections.business.title"),
    description: t("branding.sections.business.description"),
    icon: Building2,
  },
  {
    id: "logo",
    title: t("branding.sections.logo.title"),
    description: t("branding.sections.logo.description"),
    icon: ImageIcon,
  },
  {
    id: "colors",
    title: t("branding.sections.colors.title"),
    description: t("branding.sections.colors.description"),
    icon: Palette,
  },
  {
    id: "templates",
    title: t("branding.sections.templates.title"),
    description: t("branding.sections.templates.description"),
    icon: SwatchBook,
  },
  {
    id: "preview",
    title: t("branding.sections.preview.title"),
    description: t("branding.sections.preview.description"),
    icon: Eye,
  },
  ];
}

function localizedTemplateOptions(t: TFunction): QuoteTemplateOption[] {
  return QUOTE_TEMPLATE_OPTIONS.map((template) => ({
    ...template,
    name: t(`branding.templates.${template.id}.name`),
    bestFor: t(`branding.templates.${template.id}.bestFor`),
    description: t(`branding.templates.${template.id}.description`),
  }));
}

function formatPreviewDate(locale: SupportedLocale, timeZone: string) {
  const date = new Date("2026-04-10T12:00:00.000Z");
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(date);
  }
}

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function getSupportedTimezones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      return Intl.supportedValuesOf("timeZone");
    }
  } catch {
    // Fallback handled below.
  }
  return FALLBACK_TIMEZONES;
}

function normalizeBusinessProfile(branding?: BrandingBusinessProfile | null): BrandingBusinessProfile {
  return {
    businessEmail: branding?.businessEmail ?? "",
    businessPhone: branding?.businessPhone ?? "",
    quoteMessageTemplate: branding?.quoteMessageTemplate ?? "",
    addressLine1: branding?.addressLine1 ?? "",
    addressLine2: branding?.addressLine2 ?? "",
    city: branding?.city ?? "",
    state: branding?.state ?? "",
    postalCode: branding?.postalCode ?? "",
  };
}

function formatBusinessAddress(profile: BrandingBusinessProfile): string[] {
  const lines: string[] = [];
  if (profile.addressLine1?.trim()) lines.push(profile.addressLine1.trim());
  if (profile.addressLine2?.trim()) lines.push(profile.addressLine2.trim());

  const cityStateZip = [profile.city?.trim(), profile.state?.trim(), profile.postalCode?.trim()]
    .filter(Boolean)
    .join(profile.city?.trim() && profile.state?.trim() ? ", " : " ");

  if (cityStateZip) lines.push(cityStateZip);
  return lines;
}

function getContrastingTextColor(color: string): string {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#5B85AA";
  const red = Number.parseInt(safe.slice(1, 3), 16);
  const green = Number.parseInt(safe.slice(3, 5), 16);
  const blue = Number.parseInt(safe.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#111111" : "#ffffff";
}

function getRelativeLuminance(color: string): number {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000000";
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(safe.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function getContrastRatio(first: string, second: string): number {
  const firstLuminance = getRelativeLuminance(first);
  const secondLuminance = getRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function normalizeComponentColors(colors?: BrandingComponentColors | null): BrandingComponentColors {
  if (!colors) return {};

  return {
    ...(colors.headerBgColor ? { headerBgColor: colors.headerBgColor } : {}),
    ...(colors.sectionTitleColor ? { sectionTitleColor: colors.sectionTitleColor } : {}),
    ...(colors.tableHeaderBgColor ? { tableHeaderBgColor: colors.tableHeaderBgColor } : {}),
    ...(colors.tableHeaderTextColor ? { tableHeaderTextColor: colors.tableHeaderTextColor } : {}),
    ...(colors.totalsColor ? { totalsColor: colors.totalsColor } : {}),
    ...(colors.footerTextColor ? { footerTextColor: colors.footerTextColor } : {}),
  };
}

function buildBrandingSnapshot(input: {
  companyName: string;
  logo: string | null;
  logoPosition: BrandingLogoPosition;
  hideQuoteFlyAttribution: boolean;
  brandColor: string;
  timezone: string;
  defaultCustomerLocale: SupportedLocale;
  businessProfile: BrandingBusinessProfile;
  selectedTemplate: StandardQuoteTemplateId;
  componentColors: BrandingComponentColors;
}): string {
  return JSON.stringify({
    ...input,
    companyName: input.companyName.trim(),
    businessProfile: normalizeBusinessProfile(input.businessProfile),
    componentColors: normalizeComponentColors(input.componentColors),
  });
}

function normalizeBusinessProfileForSave(profile: BrandingBusinessProfile): BrandingBusinessProfile {
  const normalize = (value?: string | null) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };

  return {
    businessEmail: normalize(profile.businessEmail),
    businessPhone: normalize(profile.businessPhone),
    quoteMessageTemplate: normalize(profile.quoteMessageTemplate),
    addressLine1: normalize(profile.addressLine1),
    addressLine2: normalize(profile.addressLine2),
    city: normalize(profile.city),
    state: normalize(profile.state),
    postalCode: normalize(profile.postalCode),
  };
}

function TemplateMiniPreview({
  template,
  active,
  onSelect,
}: {
  template: QuoteTemplateOption;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-w-0 rounded-[24px] border p-3 text-left shadow-sm transition ${
        active
          ? "border-quotefly-primary bg-[var(--qf-selected)] shadow-[var(--qf-shadow-md)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:border-quotefly-primary/40 hover:bg-[var(--qf-interactive-hover)] hover:shadow-[var(--qf-shadow-md)]"
      }`}
      aria-pressed={active}
    >
      <div className={`rounded-[20px] border border-slate-200 p-3 ${template.preview}`}>
        {template.headerStyle === "bar" ? (
          <>
            <div className="h-2 rounded-full bg-quotefly-blue" />
            <div className="mt-3 grid gap-2">
              <div className="h-2 rounded-full bg-slate-300/90" />
              <div className="h-2 w-4/5 rounded-full bg-slate-200/95" />
              <div className="h-12 rounded-2xl border border-slate-200 bg-white/90" />
            </div>
          </>
        ) : template.headerStyle === "card" ? (
          <>
            <div className="rounded-2xl border border-slate-200 bg-white/95 p-2.5">
              <div className="flex items-center gap-2">
                <div className="h-10 w-1.5 rounded-full bg-quotefly-blue" />
                <div className="h-7 w-7 rounded-xl bg-slate-200" />
                <div className="flex-1">
                  <div className="h-2 rounded-full bg-slate-700/80" />
                  <div className="mt-1 h-2 w-2/3 rounded-full bg-slate-300" />
                </div>
              </div>
            </div>
            <div className="mt-3 h-14 rounded-2xl border border-slate-200 bg-white/85" />
          </>
        ) : (
          <>
            <div className="border-b border-slate-300 pb-2">
              <div className="h-2 w-1/2 rounded-full bg-slate-700/80" />
            </div>
            <div className="mt-3 h-14 rounded-2xl border border-slate-200 bg-white" />
          </>
        )}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--qf-text)]">{template.name}</p>
          {active ? (
            <span className="rounded-full bg-quotefly-blue/[0.08] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-quotefly-blue">
              {t("branding.completion.selected")}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{template.bestFor}</p>
        <p className="mt-2 text-xs text-[var(--qf-text-soft)]">{template.description}</p>
      </div>
    </button>
  );
}

export function BrandingPage({ tenantId, effectivePlanCode = "starter" }: BrandingPageProps) {
  const { t } = useTranslation();
  useEffect(() => {
    setSEOMetadata({
      title: t("branding.seoTitle"),
      description: t("branding.seoDescription"),
      keywords: t("branding.seoKeywords"),
    });
  }, [t]);

  const effectiveTenantId = tenantId ?? localStorage.getItem("qf_tenant_id") ?? undefined;
  const browserTimezone = useMemo(() => getBrowserTimezone(), []);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);
  const sections = useMemo(() => brandingSections(t), [t]);
  const componentOptions = useMemo(() => colorComponents(t), [t]);
  const logoPositions = useMemo(() => logoPositionOptions(t), [t]);
  const templates = useMemo(() => localizedTemplateOptions(t), [t]);

  const [companyName, setCompanyName] = useState("QuoteFly Services");
  const [canEditBusinessName, setCanEditBusinessName] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoPosition, setLogoPosition] = useState<BrandingLogoPosition>("left");
  const [hideQuoteFlyAttribution, setHideQuoteFlyAttribution] = useState(false);
  const [brandColor, setBrandColor] = useState("#5B85AA");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [defaultCustomerLocale, setDefaultCustomerLocale] = useState<SupportedLocale>("en-US");
  const [businessProfile, setBusinessProfile] = useState<BrandingBusinessProfile>(EMPTY_BUSINESS_PROFILE);
  const [selectedTemplate, setSelectedTemplate] = useState<StandardQuoteTemplateId>("modern");
  const [componentColors, setComponentColors] = useState<BrandingComponentColors>({});
  const [isLoading, setIsLoading] = useState(Boolean(effectiveTenantId));
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<BrandingSectionId, boolean>>({
    business: false,
    logo: false,
    colors: false,
    templates: false,
    preview: true,
  });
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!effectiveTenantId) {
      setIsLoading(false);
      setHasLoaded(false);
      setCanEditBusinessName(false);
      setLoadErrorMessage(null);
      setLastSavedSnapshot(null);
      return;
    }

    let isActive = true;
    setIsLoading(true);
    setHasLoaded(false);
    setLoadErrorMessage(null);
    setSaveErrorMessage(null);

    api.branding
      .get(effectiveTenantId)
      .then(({ tenant, branding, permissions }) => {
        if (!isActive) return;

        const nextTimezone = tenant.timezone === "UTC" ? browserTimezone : tenant.timezone;
        const nextLogo = isSupportedBrandLogoDataUrl(branding?.logoUrl) ? branding.logoUrl : null;
        const nextBrandColor = branding?.primaryColor ?? "#5B85AA";
        const nextTemplate = normalizeQuoteTemplateId(branding?.templateId);
        const nextLogoPosition = branding?.logoPosition ?? "left";
        const nextHideAttribution = Boolean(branding?.hideQuoteFlyAttribution);
        const nextComponentColors = normalizeComponentColors(branding?.componentColors);
        const nextBusinessProfile = normalizeBusinessProfile(branding);

        setCompanyName(tenant.name);
        setCanEditBusinessName(permissions.canEditBusinessName);
        setTimezone(nextTimezone);
        setDefaultCustomerLocale(tenant.defaultCustomerLocale);
        setLogo(nextLogo);
        setBrandColor(nextBrandColor);
        setSelectedTemplate(nextTemplate);
        setLogoPosition(nextLogoPosition);
        setHideQuoteFlyAttribution(nextHideAttribution);
        setComponentColors(nextComponentColors);
        setBusinessProfile(nextBusinessProfile);
        setLastSavedSnapshot(
          buildBrandingSnapshot({
            companyName: tenant.name,
            logo: nextLogo,
            logoPosition: nextLogoPosition,
            hideQuoteFlyAttribution: nextHideAttribution,
            brandColor: nextBrandColor,
            timezone: nextTimezone,
            defaultCustomerLocale: tenant.defaultCustomerLocale,
            businessProfile: nextBusinessProfile,
            selectedTemplate: nextTemplate,
            componentColors: nextComponentColors,
          }),
        );
        setHasLoaded(true);
      })
      .catch((error) => {
        if (!isActive) return;
        setCanEditBusinessName(false);
        setLoadErrorMessage(t("branding.loadFallback"));
        console.error("Failed to load branding:", error);
        setHasLoaded(false);
      })
      .finally(() => {
        if (isActive) setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [browserTimezone, effectiveTenantId, loadAttempt, t]);

  useEffect(
    () => () => {
      if (saveStatusTimerRef.current !== null) {
        window.clearTimeout(saveStatusTimerRef.current);
      }
    },
    [],
  );

  const selectedTemplateIndex = useMemo(() => {
    const index = templates.findIndex((template) => template.id === selectedTemplate);
    return index >= 0 ? index : 0;
  }, [selectedTemplate, templates]);

  const activeTemplate = templates[selectedTemplateIndex] ?? {
    ...getQuoteTemplateOption(selectedTemplate),
    name: t(`branding.templates.${selectedTemplate}.name`),
    bestFor: t(`branding.templates.${selectedTemplate}.bestFor`),
    description: t(`branding.templates.${selectedTemplate}.description`),
  };
  const businessAddressLines = formatBusinessAddress(businessProfile);
  const hasBusinessInfo = Boolean(
    businessProfile.businessEmail?.trim() ||
      businessProfile.businessPhone?.trim() ||
      businessProfile.quoteMessageTemplate?.trim() ||
      businessProfile.addressLine1?.trim() ||
      businessProfile.city?.trim() ||
      businessProfile.state?.trim() ||
      businessProfile.postalCode?.trim(),
  );
  const completedSectionCount = [hasBusinessInfo, Boolean(logo), Boolean(brandColor), Boolean(selectedTemplate)].filter(
    Boolean,
  ).length;
  const sectionCompletionLabel: Partial<Record<BrandingSectionId, string>> = {
    business: hasBusinessInfo ? t("branding.completion.ready") : undefined,
    logo: logo ? t("branding.completion.uploaded") : undefined,
    colors: brandColor ? t("branding.completion.set") : undefined,
    templates: selectedTemplate ? t("branding.completion.selected") : undefined,
    preview: t("branding.completion.live"),
  };
  const brandingLinks = sections.map((section) => ({
    id: `branding-${section.id}`,
    label: section.title,
    hint: section.description,
  }));
  const currentSnapshot = useMemo(
    () =>
      buildBrandingSnapshot({
        companyName,
        logo,
        logoPosition,
        hideQuoteFlyAttribution,
        brandColor,
        timezone,
        defaultCustomerLocale,
        businessProfile,
        selectedTemplate,
        componentColors,
      }),
    [
      brandColor,
      businessProfile,
      companyName,
      componentColors,
      hideQuoteFlyAttribution,
      logo,
      logoPosition,
      selectedTemplate,
      timezone,
      defaultCustomerLocale,
    ],
  );
  const isDirty = hasLoaded && lastSavedSnapshot !== currentSnapshot;
  const isBusinessNameInvalid = canEditBusinessName && companyName.trim().length < 2;
  const {
    navigationPromptOpen,
    cancelNavigation,
    continueNavigation,
  } = useUnsavedChangesGuard(isDirty && !isSaving, {
    historyPrompt: t("branding.leavePrompt"),
  });

  const toggleSection = (sectionId: BrandingSectionId) => {
    setOpenSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  const focusSection = (sectionId: BrandingSectionId) => {
    setOpenSections((prev) => ({ ...prev, [sectionId]: true }));

    window.requestAnimationFrame(() => {
      document.getElementById(`branding-${sectionId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const handleSave = async () => {
    if (!effectiveTenantId || !hasLoaded || isLoading || !isDirty || isBusinessNameInvalid) return;

    setIsSaving(true);
    setSaveStatus("idle");
    setSaveErrorMessage(null);

    try {
      const normalizedComponentColors = normalizeComponentColors(componentColors);
      const componentColorPayload = Object.keys(normalizedComponentColors).length > 0 ? normalizedComponentColors : null;

      const result = await api.branding.save(effectiveTenantId, {
        ...(canEditBusinessName ? { businessName: companyName.trim() } : {}),
        logoUrl: logo ?? null,
        logoPosition,
        hideQuoteFlyAttribution,
        primaryColor: brandColor,
        templateId: selectedTemplate,
        timezone,
        defaultCustomerLocale,
        businessProfile: normalizeBusinessProfileForSave(businessProfile),
        componentColors: componentColorPayload,
      });

      const nextTimezone = result.tenant.timezone === "UTC" ? browserTimezone : result.tenant.timezone;
      const nextLogo = isSupportedBrandLogoDataUrl(result.branding.logoUrl) ? result.branding.logoUrl : null;
      const nextTemplate = normalizeQuoteTemplateId(result.branding.templateId);
      const nextLogoPosition = result.branding.logoPosition ?? "left";
      const nextHideAttribution = Boolean(result.branding.hideQuoteFlyAttribution);
      const nextComponentColors = normalizeComponentColors(result.branding.componentColors);
      const nextBusinessProfile = normalizeBusinessProfile(result.branding);

      setCompanyName(result.tenant.name);
      setTimezone(nextTimezone);
      setDefaultCustomerLocale(result.tenant.defaultCustomerLocale);
      setBrandColor(result.branding.primaryColor);
      setSelectedTemplate(nextTemplate);
      setLogo(nextLogo);
      setLogoPosition(nextLogoPosition);
      setHideQuoteFlyAttribution(nextHideAttribution);
      setComponentColors(nextComponentColors);
      setBusinessProfile(nextBusinessProfile);
      setLastSavedSnapshot(
        buildBrandingSnapshot({
          companyName: result.tenant.name,
          logo: nextLogo,
          logoPosition: nextLogoPosition,
          hideQuoteFlyAttribution: nextHideAttribution,
          brandColor: result.branding.primaryColor,
          timezone: nextTimezone,
          defaultCustomerLocale: result.tenant.defaultCustomerLocale,
          businessProfile: nextBusinessProfile,
          selectedTemplate: nextTemplate,
          componentColors: nextComponentColors,
        }),
      );

      setSaveStatus("saved");
      if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = window.setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveErrorMessage(t("branding.saveFallback"));
      console.error("Failed to save branding:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setSaveStatus("error");
      setSaveErrorMessage(t("branding.logoSection.invalidType"));
      event.target.value = "";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setSaveStatus("error");
      setSaveErrorMessage(t("branding.logoSection.tooLarge"));
      event.target.value = "";
      return;
    }

    try {
      const normalizedLogo = await resizeBrandLogoFile(file);
      setLogo(normalizedLogo);
      setSaveStatus("idle");
      setSaveErrorMessage(null);
    } catch (err) {
      setSaveStatus("error");
      setSaveErrorMessage(t("branding.logoSection.processFailed"));
      console.error("Failed to process branding logo:", err);
    } finally {
      event.target.value = "";
    }
  };

  const getComponentFallback = (key: keyof BrandingComponentColors): string =>
    key === "footerTextColor"
      ? "#666666"
      : key === "headerTextColor"
        ? getContrastingTextColor(getComponentColorValue("headerBgColor"))
        : key === "tableHeaderTextColor"
          ? getContrastingTextColor(getComponentColorValue("tableHeaderBgColor"))
          : brandColor;

  const getComponentColorValue = (key: keyof BrandingComponentColors): string =>
    componentColors[key] ?? getComponentFallback(key);

  const updateComponentColor = (key: keyof BrandingComponentColors, value: string) => {
    setComponentColors((prev) => ({ ...prev, [key]: value }));
  };

  const clearComponentColorOverride = (key: keyof BrandingComponentColors) => {
    setComponentColors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const updateBusinessField = (key: keyof BrandingBusinessProfile, value: string) => {
    setBusinessProfile((prev) => ({ ...prev, [key]: value }));
  };

  const previewHeaderColor = getComponentColorValue("headerBgColor");
  const previewBusinessHint = [
    ...businessAddressLines,
    businessProfile.businessPhone?.trim(),
    businessProfile.businessEmail?.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const previewFooterText = buildQuoteFooterText({
    businessName: companyName,
    businessPhone: businessProfile.businessPhone,
    businessEmail: businessProfile.businessEmail,
  });
  const showQuoteFlyAttribution = shouldShowQuoteFlyAttribution(
    effectivePlanCode,
    hideQuoteFlyAttribution,
  );
  const previewComponentColors: BrandingComponentColors = {
    headerBgColor: previewHeaderColor,
    sectionTitleColor: getComponentColorValue("sectionTitleColor"),
    tableHeaderBgColor: getComponentColorValue("tableHeaderBgColor"),
    tableHeaderTextColor: getComponentColorValue("tableHeaderTextColor"),
    totalsColor: getComponentColorValue("totalsColor"),
    footerTextColor: getComponentColorValue("footerTextColor"),
  };
  const componentColorOverrideCount = Object.keys(normalizeComponentColors(componentColors)).length;
  const documentT = i18n.getFixedT(defaultCustomerLocale);
  const previewPreparedDate = formatPreviewDate(defaultCustomerLocale, timezone);
  const contrastWarnings = [
    {
      label: t("branding.colors.components.tableText.label"),
      ratio: getContrastRatio(
        previewComponentColors.tableHeaderTextColor ?? "#ffffff",
        previewComponentColors.tableHeaderBgColor ?? brandColor,
      ),
    },
    {
      label: t("branding.colors.components.sectionTitle.label"),
      ratio: getContrastRatio(previewComponentColors.sectionTitleColor ?? brandColor, "#ffffff"),
    },
    {
      label: t("branding.colors.components.totals.label"),
      ratio: getContrastRatio(previewComponentColors.totalsColor ?? brandColor, "#ffffff"),
    },
    {
      label: t("branding.colors.components.footerText.label"),
      ratio: getContrastRatio(previewComponentColors.footerTextColor ?? "#666666", "#ffffff"),
    },
  ].filter((warning) => warning.ratio < 4.5);
  return (
    <div className="space-y-5 pb-24 xl:pb-0">
        <PageHeader
          title={t("branding.title")}
          subtitle={t("branding.subtitle")}
          mode="actions-only"
          actions={hasLoaded ? <Badge tone="blue">{t("branding.readyCount", { count: completedSectionCount })}</Badge> : undefined}
        />

        {!effectiveTenantId ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h2 className="font-display text-xl font-semibold text-slate-900">{t("branding.signInTitle")}</h2>
            <p className="mt-2 text-sm text-slate-500">{t("branding.signInDescription")}</p>
          </div>
        ) : isLoading ? (
          <LoadingState
            title={t("branding.loading")}
            description={t("branding.loadingDescription")}
            variant="cards"
            rows={4}
          />
        ) : loadErrorMessage || !hasLoaded ? (
          <div className="rounded-[28px] border border-red-200 bg-white p-8 text-center shadow-sm" role="alert">
            <h2 className="font-display text-xl font-semibold text-slate-900">{t("branding.loadFailed")}</h2>
            <p className="mt-2 text-sm text-red-600">{loadErrorMessage ?? t("branding.loadFallback")}</p>
            <Button
              type="button"
              variant="outline"
              icon={<RefreshCw size={15} />}
              className="mt-5"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              {t("branding.tryAgain")}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:gap-6 xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4 xl:sticky xl:top-24 xl:self-start">
            <WorkspaceRailCard
              eyebrow={t("branding.setup")}
              title={companyName}
              description={t("branding.setupDescription")}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1">
                <BrandingSummaryTile label={t("branding.timezone")}>
                  <p className="text-sm font-semibold text-slate-900">{timezone}</p>
                </BrandingSummaryTile>
                <BrandingSummaryTile label={t("branding.customerLanguage")}>
                  <p className="text-sm font-semibold text-slate-900">
                    {defaultCustomerLocale === "es-US" ? t("branding.spanishUs") : t("branding.englishUs")}
                  </p>
                </BrandingSummaryTile>
                <BrandingSummaryTile label={t("branding.template")}>
                  <p className="text-sm font-semibold text-slate-900">{activeTemplate.name}</p>
                </BrandingSummaryTile>
                <BrandingSummaryTile label={t("branding.logo")}>
                  {logo ? (
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-16 items-center justify-center rounded-xl border border-slate-200 bg-white px-2">
                        <img src={logo} alt={t("branding.savedLogoAlt")} className="max-h-8 w-auto max-w-full object-contain" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{t("branding.active")}</p>
                        <p className="text-xs text-slate-500">{t("branding.activeEverywhere")}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm font-semibold text-slate-900">{t("branding.notUploaded")}</p>
                  )}
                </BrandingSummaryTile>
                <BrandingSummaryTile label={t("branding.placement")}>
                  <p className="text-sm font-semibold text-slate-900">{t(`branding.placementValue.${logoPosition}`)}</p>
                </BrandingSummaryTile>
                <BrandingSummaryTile label={t("branding.footer")}>
                  <p className="text-sm font-semibold text-slate-900">
                    {showQuoteFlyAttribution ? t("branding.footerVisible") : t("branding.footerHidden")}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    {effectivePlanCode === "starter"
                      ? t("branding.starterAttribution")
                      : t("branding.paidAttribution")}
                  </p>
                </BrandingSummaryTile>
              </div>
              <ProgressBar
                value={(completedSectionCount / 4) * 100}
                label={t("branding.completionLabel")}
                hint={t("branding.readyCount", { count: completedSectionCount })}
                className="mt-4"
              />
              <WorkspaceJumpBar links={brandingLinks} className="mt-4" />
            </WorkspaceRailCard>

            <WorkspaceRailCard
              eyebrow={t("branding.saveEyebrow")}
              title={t("branding.outputTitle")}
              description={t("branding.outputDescription")}
            >
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {sections.map((section) => {
                    const completion = sectionCompletionLabel[section.id];

                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => focusSection(section.id)}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-white"
                      >
                        {completion ? <CheckCircle2 size={14} className="text-emerald-600" /> : <span className="h-2 w-2 rounded-full bg-slate-300" />}
                        {section.title}
                      </button>
                    );
                  })}
                </div>
                <Button onClick={handleSave} disabled={isSaving || !isDirty || isBusinessNameInvalid} loading={isSaving} fullWidth>
                  {isSaving ? t("branding.saving") : isDirty ? t("branding.saveBranding") : t("branding.brandingSaved")}
                </Button>
                <div className="min-h-[20px] text-sm" aria-live="polite">
                  {saveStatus === "saved" && !isDirty ? <span className="font-medium text-quotefly-blue">{t("branding.saved")}</span> : null}
                  {saveStatus === "error" ? <span className="font-medium text-red-500">{saveErrorMessage ?? t("branding.saveFailed")}</span> : null}
                  {isDirty && saveStatus !== "error" ? <span className="font-medium text-amber-700">{t("branding.unsaved")}</span> : null}
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  {t("branding.saveHelp")}
                </p>
              </div>
            </WorkspaceRailCard>
          </aside>

          <div className="min-w-0 space-y-5">
            <BrandQuickSetup
              brandColor={brandColor}
              componentColorOverrideCount={componentColorOverrideCount}
              isBusinessNameInvalid={isBusinessNameInvalid}
              isDirty={isDirty}
              isSaving={isSaving}
              logo={logo}
              logoInputRef={logoInputRef}
              logoPosition={logoPosition}
              selectedTemplate={selectedTemplate}
              onBrandColorChange={setBrandColor}
              onClearComponentColors={() => setComponentColors({})}
              onLogoPositionChange={setLogoPosition}
              onLogoRemove={() => setLogo(null)}
              onLogoUpload={handleLogoUpload}
              onSave={handleSave}
              onTemplateChange={setSelectedTemplate}
              onViewPreview={() => focusSection("preview")}
            />

            <BrandingSectionCard
              id="branding-business"
              title={t("branding.business.title")}
              description={t("branding.business.description")}
              icon={Building2}
              isOpen={openSections.business}
              completionLabel={sectionCompletionLabel.business}
              onToggle={() => toggleSection("business")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Input
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                    disabled={!canEditBusinessName}
                    label={t("branding.business.name")}
                    maxLength={120}
                    className={!canEditBusinessName ? "bg-slate-100 text-slate-700" : undefined}
                  />
                  <p className={`mt-1 text-xs ${isBusinessNameInvalid ? "text-red-600" : "text-slate-500"}`}>
                    {isBusinessNameInvalid
                      ? t("branding.business.nameInvalid")
                      : canEditBusinessName
                      ? t("branding.business.nameEditable")
                      : t("branding.business.nameLocked")}
                  </p>
                </div>
                <Input
                  label={t("branding.business.email")}
                  type="email"
                  value={businessProfile.businessEmail ?? ""}
                  onChange={(event) => updateBusinessField("businessEmail", event.target.value)}
                  placeholder="office@yourcompany.com"
                />
                <Input
                  label={t("branding.business.phone")}
                  type="tel"
                  value={businessProfile.businessPhone ?? ""}
                  onChange={(event) => updateBusinessField("businessPhone", event.target.value)}
                  placeholder="(555) 123-4567"
                />
                <div className="md:col-span-2">
                  <Textarea
                    label={t("branding.business.message")}
                    rows={7}
                    value={businessProfile.quoteMessageTemplate ?? ""}
                    onChange={(event) => updateBusinessField("quoteMessageTemplate", event.target.value)}
                    placeholder={t("branding.business.messagePlaceholder")}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {t("branding.business.messageHelp")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {QUOTE_MESSAGE_TEMPLATE_TOKENS.map((token) => (
                      <Badge key={token} tone="slate">
                        {token}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Input
                  label={t("branding.business.address1")}
                  value={businessProfile.addressLine1 ?? ""}
                  onChange={(event) => updateBusinessField("addressLine1", event.target.value)}
                  placeholder="123 Main Street"
                />
                <Input
                  label={t("branding.business.address2")}
                  value={businessProfile.addressLine2 ?? ""}
                  onChange={(event) => updateBusinessField("addressLine2", event.target.value)}
                  placeholder="Suite 200"
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <Input
                      label={t("branding.business.city")}
                      value={businessProfile.city ?? ""}
                      onChange={(event) => updateBusinessField("city", event.target.value)}
                      placeholder="Charlotte"
                    />
                  </div>
                  <Input
                    label={t("branding.business.state")}
                      value={businessProfile.state ?? ""}
                      onChange={(event) => updateBusinessField("state", event.target.value)}
                      placeholder="NC"
                  />
                  <Input
                    label={t("branding.business.zip")}
                      value={businessProfile.postalCode ?? ""}
                      onChange={(event) => updateBusinessField("postalCode", event.target.value)}
                      placeholder="28202"
                  />
                </div>
                <div>
                  <div className="mb-1 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <label className="block text-xs font-medium text-slate-600">{t("branding.timezone")}</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => setTimezone(browserTimezone)}
                    >
                      <span className="sm:hidden">{t("branding.business.useLocal")}</span>
                      <span className="hidden sm:inline">{t("branding.business.useLocalNamed", { timezone: browserTimezone })}</span>
                    </Button>
                  </div>
                  <Select
                    label=""
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    options={timezoneOptions.map((option) => ({ value: option, label: option }))}
                  />
                </div>
                <div>
                  <Select
                    label={t("branding.business.defaultLanguage")}
                    value={defaultCustomerLocale}
                    disabled={!canEditBusinessName}
                    onChange={(event) =>
                      setDefaultCustomerLocale(event.target.value as SupportedLocale)
                    }
                    options={[
                      { value: "en-US", label: t("branding.englishUs") },
                      { value: "es-US", label: t("branding.spanishUs") },
                    ]}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {t("branding.business.languageHelp")}
                  </p>
                </div>
                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{t("branding.business.footerTitle")}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {t("branding.business.footerDescription")}
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={showQuoteFlyAttribution}
                        disabled={effectivePlanCode === "starter"}
                        onChange={(event) => setHideQuoteFlyAttribution(!event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-quotefly-blue focus:ring-quotefly-blue"
                      />
                      {t("branding.business.showFooter")}
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {effectivePlanCode === "starter"
                      ? t("branding.starterAttribution")
                      : t("branding.business.footerPaidHelp")}
                  </p>
                </div>
              </div>
            </BrandingSectionCard>

            <BrandingSectionCard
              id="branding-logo"
              title={t("branding.logo")}
              description={t("branding.logoSection.description")}
              icon={ImageIcon}
              isOpen={openSections.logo}
              completionLabel={sectionCompletionLabel.logo}
              onToggle={() => toggleSection("logo")}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  {logo ? (
                    <>
                      <div className="flex min-h-[180px] items-center justify-center rounded-xl border-2 border-dashed border-quotefly-primary bg-quotefly-primary/5 p-6">
                        <img src={logo} alt={t("branding.logoSection.yourLogoAlt")} className="max-h-28 max-w-full object-contain" />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" variant="outline" icon={<Upload size={14} />} onClick={() => logoInputRef.current?.click()}>
                          {t("branding.logoSection.replace")}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setLogo(null)}>
                          {t("branding.logoSection.remove")}
                        </Button>
                        <p className="text-xs leading-5 text-slate-500">
                          {t("branding.logoSection.readyHelp")}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition-colors hover:border-quotefly-primary">
                        <Upload size={28} className="mx-auto mb-3 text-slate-400" />
                        <p className="text-sm font-medium text-slate-700">{t("branding.logoSection.add")}</p>
                        <p className="mt-1 text-xs text-slate-600">{t("branding.logoSection.formats")}</p>
                        <Button
                          type="button"
                          variant="outline"
                          icon={<Upload size={14} />}
                          className="mt-4"
                          onClick={() => logoInputRef.current?.click()}
                        >
                          {t("branding.logoSection.choose")}
                        </Button>
                    </div>
                  )}

                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">{t("branding.logoSection.placementTitle")}</p>
                    <p className="mt-1 text-sm text-slate-500">
                      {t("branding.logoSection.placementDescription")}
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      {logoPositions.map((option) => {
                        const Icon = option.icon;
                        const active = logoPosition === option.value;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setLogoPosition(option.value)}
                            className={`min-h-11 rounded-[20px] border px-4 py-3 text-left transition ${
                              active
                                ? "border-quotefly-blue bg-quotefly-blue/[0.06] shadow-[0_10px_24px_rgba(42,127,216,0.10)]"
                                : "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white"
                            }`}
                            aria-pressed={active}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex h-9 w-9 items-center justify-center rounded-2xl border ${
                                  active
                                    ? "border-quotefly-blue/20 bg-white text-quotefly-blue"
                                    : "border-slate-200 bg-white text-slate-500"
                                }`}
                              >
                                <Icon size={16} />
                              </span>
                              <div>
                                <p className="text-sm font-semibold text-slate-900">{option.label}</p>
                                <p className="text-xs text-slate-500">{option.description}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-900">{t("branding.logoSection.guidance")}</p>
                  <ul className="mt-3 space-y-2 text-sm text-slate-600">
                    <li>{t("branding.logoSection.guidanceTransparent")}</li>
                    <li>{t("branding.logoSection.guidanceWide")}</li>
                    <li>{t("branding.logoSection.guidanceHeaders")}</li>
                  </ul>
                  <div className="mt-5 rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("branding.logoSection.currentStatus")}</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{logo ? t("branding.logoSection.selected") : t("branding.logoSection.none")}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {logo
                        ? t("branding.logoSection.selectedHelp")
                        : t("branding.logoSection.noneHelp")}
                    </p>
                  </div>
                </div>
              </div>
            </BrandingSectionCard>

            <BrandingSectionCard
              id="branding-colors"
              title={t("branding.sections.colors.title")}
              description={t("branding.colors.description")}
              icon={Palette}
              isOpen={openSections.colors}
              completionLabel={sectionCompletionLabel.colors}
              onToggle={() => toggleSection("colors")}
            >
              <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="font-display text-lg font-semibold text-slate-900">{t("branding.colors.primaryTitle")}</h3>

                  <div className="mt-4 space-y-3">
                    <label htmlFor="branding-primary-color" className="block text-xs font-medium text-slate-600">
                      {t("branding.colors.primary")}
                    </label>
                    <input
                      id="branding-primary-color"
                      type="color"
                      value={brandColor}
                      onChange={(event) => setBrandColor(event.target.value)}
                      className="h-12 w-full cursor-pointer rounded-lg"
                    />
                    <p className="text-center font-mono text-xs text-slate-500">{brandColor}</p>
                    <div style={{ backgroundColor: brandColor }} className="h-20 rounded-lg border border-slate-200" />
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-4">
                    <h3 className="font-display text-lg font-semibold text-slate-900">{t("branding.colors.overrides")}</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {t("branding.colors.overridesDescription")}
                    </p>
                  </div>

                  <div className="space-y-4">
                    {componentOptions.map((component) => {
                      const value = getComponentColorValue(component.key);
                      const hasOverride = componentColors[component.key] !== undefined;
                      const resetLabel =
                        component.key === "footerTextColor"
                          ? t("branding.colors.resetNeutral")
                          : component.key === "tableHeaderTextColor"
                            ? t("branding.colors.resetContrast")
                            : t("branding.colors.resetBrand");

                      return (
                        <div key={component.key} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <label
                                htmlFor={`branding-color-${component.key}`}
                                className="text-sm font-semibold text-slate-800"
                              >
                                {component.label}
                              </label>
                              <p className="text-xs text-slate-500">{component.description}</p>
                            </div>
                            <div className="flex items-center gap-2 self-start sm:self-auto">
                              <input
                                id={`branding-color-${component.key}`}
                                type="color"
                                value={value}
                                onChange={(event) => updateComponentColor(component.key, event.target.value)}
                                className="h-11 w-12 cursor-pointer rounded border border-slate-300"
                              />
                              <span className="w-20 text-right font-mono text-xs text-slate-500">{value}</span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="h-2 flex-1 rounded" style={{ backgroundColor: value }} />
                            <button
                              type="button"
                              onClick={() => clearComponentColorOverride(component.key)}
                              disabled={!hasOverride}
                              className="min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                            >
                              {resetLabel}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              {contrastWarnings.length > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4" role="status">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
                    <div>
                      <p className="text-sm font-semibold text-amber-950">{t("branding.colors.warningTitle")}</p>
                      <p className="mt-1 text-xs leading-5 text-amber-900">
                        {t("branding.colors.warningDescription", {
                          warnings: contrastWarnings.map((warning) => `${warning.label} (${warning.ratio.toFixed(1)}:1)`).join(", "),
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </BrandingSectionCard>

            <BrandingSectionCard
              id="branding-templates"
              title={t("branding.sections.templates.title")}
              description={t("branding.templatesDescription")}
              icon={SwatchBook}
              isOpen={openSections.templates}
              completionLabel={sectionCompletionLabel.templates}
              onToggle={() => toggleSection("templates")}
            >
              <div className="rounded-[28px] border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)]">
                <div className="grid gap-3 md:grid-cols-3">
                  {templates.map((template) => (
                    <TemplateMiniPreview
                      key={template.id}
                      template={template}
                      active={selectedTemplate === template.id}
                      onSelect={() => setSelectedTemplate(template.id)}
                    />
                  ))}
                </div>
              </div>
            </BrandingSectionCard>

            <BrandingSectionCard
              id="branding-preview"
              title={t("branding.sections.preview.title")}
              description={t("branding.preview.description")}
              icon={Eye}
              isOpen={openSections.preview}
              completionLabel={sectionCompletionLabel.preview}
              onToggle={() => toggleSection("preview")}
            >
              <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-8">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">{t("branding.preview.output")}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {t("branding.preview.outputHelp")}
                    </p>
                  </div>
                  <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                    {activeTemplate.name}
                  </div>
                </div>
                <QuoteLivePreview
                  businessName={companyName}
                  businessHint={previewBusinessHint || documentT("branding.preview.businessHint")}
                  customerName={documentT("branding.preview.customerName")}
                  customerPhone="(555) 123-4567"
                  customerEmail="john@example.com"
                  preparedDateLabel={previewPreparedDate}
                  sentDateLabel={documentT("branding.preview.notAvailable")}
                  quoteTitle={documentT("branding.preview.quoteTitle")}
                  scopeText={documentT("branding.preview.scope")}
                  lines={[
                    {
                      id: "preview-line-1",
                      title: documentT("branding.preview.lineTitle"),
                      details: documentT("branding.preview.lineDetails"),
                      quantity: "1",
                      unitPrice: "2450",
                      lineTotal: 2450,
                    },
                  ]}
                  customerSubtotal={2450}
                  taxAmount={0}
                  totalAmount={2450}
                  logoUrl={logo}
                  logoPosition={logoPosition}
                  templateId={selectedTemplate}
                  accentColor={previewHeaderColor}
                  componentColors={previewComponentColors}
                  footerText={previewFooterText}
                  showQuoteFlyAttribution={showQuoteFlyAttribution}
                  documentLocale={defaultCustomerLocale}
                  quoteReferenceLabel={documentT("branding.preview.quoteReference")}
                  subtitle={documentT("branding.preview.subtitle")}
                />
              </div>
            </BrandingSectionCard>
          </div>
            </div>

            <div className="h-24 xl:hidden" aria-hidden="true" />
            <WorkflowActionDock className="xl:hidden">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1" aria-live="polite">
                  <p className="text-sm font-semibold text-[var(--qf-text)]">
                    {isDirty ? t("branding.mobile.unsaved") : t("branding.mobile.current")}
                  </p>
                  {saveStatus === "error" ? (
                    <p className="truncate text-xs text-red-600">{saveErrorMessage ?? t("branding.saveFailed")}</p>
                  ) : (
                    <p className="truncate text-xs text-[var(--qf-text-muted)]">{t("branding.mobile.details")}</p>
                  )}
                </div>
                <Button
                  onClick={handleSave}
                  disabled={isSaving || !isDirty || isBusinessNameInvalid}
                  loading={isSaving}
                  className="min-h-11 shrink-0"
                >
                  {isSaving ? t("branding.saving") : t("branding.mobile.save")}
                </Button>
              </div>
            </WorkflowActionDock>
          </>
        )}
        <ConfirmModal
          open={navigationPromptOpen}
          onClose={cancelNavigation}
          onConfirm={continueNavigation}
          title={t("branding.leaveTitle")}
          description={t("branding.leaveDescription")}
          confirmLabel={t("branding.leaveConfirm")}
          cancelLabel={t("common.cancel")}
          confirmVariant="warning"
          layer="navigationGuard"
        />
    </div>
  );
}

