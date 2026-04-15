import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  ImageIcon,
  Palette,
  SwatchBook,
  Upload,
} from "lucide-react";
import { setSEOMetadata } from "../lib/seo";
import { QUOTE_MESSAGE_TEMPLATE_TOKENS } from "../lib/quote-message-template";
import {
  api,
  ApiError,
  type BrandingBusinessProfile,
  type BrandingComponentColors,
  type BrandingLogoPosition,
  type PlanCode,
} from "../lib/api";
import { Badge, Button, Input, PageHeader, ProgressBar, Select, Textarea } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceRailCard } from "../components/ui/workspace";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
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

const COLOR_COMPONENTS: Array<{ key: keyof BrandingComponentColors; label: string; description: string }> = [
  { key: "headerBgColor", label: "Header Background", description: "Top header block color in the PDF quote." },
  { key: "headerTextColor", label: "Header Text", description: "Text color used on colored quote headers." },
  { key: "sectionTitleColor", label: "Section Titles", description: "Color for section labels like Scope and Customer." },
  { key: "tableHeaderBgColor", label: "Table Header", description: "Line-item table header background color." },
  { key: "tableHeaderTextColor", label: "Table Header Text", description: "Text color used inside the line-item table header." },
  { key: "totalsColor", label: "Totals", description: "Subtotal, tax, and total emphasis color." },
  { key: "footerTextColor", label: "Footer Text", description: "Footer and metadata text color." },
];

const LOGO_POSITION_OPTIONS: LogoPositionOption[] = [
  {
    value: "left",
    label: "Top Left",
    description: "Good for compact contractor marks.",
    icon: AlignLeft,
  },
  {
    value: "center",
    label: "Top Center",
    description: "Best for badge or stacked logos.",
    icon: AlignCenter,
  },
  {
    value: "right",
    label: "Top Right",
    description: "Good for cleaner corporate headers.",
    icon: AlignRight,
  },
];

const BRANDING_SECTIONS: BrandingSectionConfig[] = [
  {
    id: "business",
    title: "Business Info",
    description: "Sender details and timezone",
    icon: Building2,
  },
  {
    id: "logo",
    title: "Logo",
    description: "Upload or remove your mark",
    icon: ImageIcon,
  },
  {
    id: "colors",
    title: "Colors",
    description: "Primary and component styling",
    icon: Palette,
  },
  {
    id: "templates",
    title: "Templates",
    description: "Switch quote layout style",
    icon: SwatchBook,
  },
  {
    id: "preview",
    title: "Preview",
    description: "See the customer-facing output",
    icon: Eye,
  },
];

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

async function resizeLogoFile(file: File): Promise<string> {
  const readAsDataUrl = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target?.result;
        if (typeof result === "string") {
          resolve(result);
          return;
        }
        reject(new Error("Could not read logo file."));
      };
      reader.onerror = () => reject(new Error("Could not read logo file."));
      reader.readAsDataURL(file);
    });

  const dataUrl = await readAsDataUrl();

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("Could not process logo image."));
    nextImage.src = dataUrl;
  });

  const maxDimension = 1200;
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare logo image.");
  }

  context.clearRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const pngDataUrl = canvas.toDataURL("image/png");
  if (pngDataUrl.length <= 850_000) {
    return pngDataUrl;
  }

  const smallerScale = Math.min(scale, 900 / Math.max(image.width, image.height));
  const smallerWidth = Math.max(1, Math.round(image.width * smallerScale));
  const smallerHeight = Math.max(1, Math.round(image.height * smallerScale));
  canvas.width = smallerWidth;
  canvas.height = smallerHeight;
  context.clearRect(0, 0, smallerWidth, smallerHeight);
  context.drawImage(image, 0, 0, smallerWidth, smallerHeight);
  const smallerPngDataUrl = canvas.toDataURL("image/png");
  if (smallerPngDataUrl.length <= 850_000) {
    return smallerPngDataUrl;
  }

  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, smallerWidth, smallerHeight);
  context.restore();

  return canvas.toDataURL("image/jpeg", 0.86);
}

interface BrandingSectionCardProps {
  id: BrandingSectionId;
  title: string;
  description: string;
  icon: LucideIcon;
  isOpen: boolean;
  completionLabel?: string;
  onToggle: () => void;
  children: ReactNode;
}

function BrandingSectionCard({
  id,
  title,
  description,
  icon: Icon,
  isOpen,
  completionLabel,
  onToggle,
  children,
}: BrandingSectionCardProps) {
  return (
    <section
      id={`branding-${id}`}
      className="scroll-mt-24 rounded-[28px] border border-slate-200 bg-white shadow-sm"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 rounded-[28px] px-5 py-5 text-left sm:px-6"
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-quotefly-primary">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold text-slate-900">{title}</h2>
              {completionLabel ? (
                <span className="rounded-full bg-quotefly-blue/[0.08] px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-quotefly-blue">
                  {completionLabel}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          </div>
        </div>
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500">
          <ChevronDown size={18} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>

      {isOpen ? <div className="border-t border-slate-100 px-5 py-5 sm:px-6">{children}</div> : null}
    </section>
  );
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
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-w-[220px] rounded-[24px] border p-3 text-left shadow-sm transition ${
        active
          ? "border-quotefly-primary bg-quotefly-primary/[0.05] shadow-[0_12px_28px_rgba(42,127,216,0.10)]"
          : "border-slate-200 bg-white hover:border-quotefly-primary/30 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]"
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
          <p className="text-sm font-semibold text-slate-900">{template.name}</p>
          {active ? (
            <span className="rounded-full bg-quotefly-blue/[0.08] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-quotefly-blue">
              Selected
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">{template.bestFor}</p>
        <p className="mt-2 text-xs text-slate-600">{template.description}</p>
      </div>
    </button>
  );
}

export function BrandingPage({ tenantId, effectivePlanCode = "starter" }: BrandingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Quote Branding - Customize Your Quotes | QuoteFly",
      description:
        "Upload your logo, choose colors, set business sender info, and customize quote templates to match your brand.",
      keywords: "quote branding, custom quote templates, contractor branding, sender business info",
    });
  }, []);

  const effectiveTenantId = tenantId ?? localStorage.getItem("qf_tenant_id") ?? undefined;
  const browserTimezone = useMemo(() => getBrowserTimezone(), []);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);

  const [companyName, setCompanyName] = useState("QuoteFly Services");
  const [logo, setLogo] = useState<string | null>(null);
  const [logoPosition, setLogoPosition] = useState<BrandingLogoPosition>("left");
  const [hideQuoteFlyAttribution, setHideQuoteFlyAttribution] = useState(false);
  const [brandColor, setBrandColor] = useState("#5B85AA");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [businessProfile, setBusinessProfile] = useState<BrandingBusinessProfile>(EMPTY_BUSINESS_PROFILE);
  const [selectedTemplate, setSelectedTemplate] = useState<StandardQuoteTemplateId>("modern");
  const [componentColors, setComponentColors] = useState<BrandingComponentColors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<BrandingSectionId, boolean>>({
    business: true,
    logo: true,
    colors: false,
    templates: true,
    preview: true,
  });
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!effectiveTenantId) return;

    api.branding
      .get(effectiveTenantId)
      .then(({ tenant, branding }) => {
        setCompanyName(tenant.name);
        setTimezone(tenant.timezone === "UTC" ? browserTimezone : tenant.timezone);
        setLogo(branding?.logoUrl ?? null);

        if (!branding) return;

        setBrandColor(branding.primaryColor);
        setSelectedTemplate(normalizeQuoteTemplateId(branding.templateId));
        setLogoPosition(branding.logoPosition ?? "left");
        setHideQuoteFlyAttribution(Boolean(branding.hideQuoteFlyAttribution));
        setComponentColors(branding.componentColors ?? {});
        setBusinessProfile(normalizeBusinessProfile(branding));
      })
      .catch(() => {
        // Silently ignore while auth/session is not ready yet.
      });
  }, [browserTimezone, effectiveTenantId]);

  const selectedTemplateIndex = useMemo(() => {
    const index = QUOTE_TEMPLATE_OPTIONS.findIndex((template) => template.id === selectedTemplate);
    return index >= 0 ? index : 0;
  }, [selectedTemplate]);

  const activeTemplate = QUOTE_TEMPLATE_OPTIONS[selectedTemplateIndex] ?? getQuoteTemplateOption(selectedTemplate);
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
    business: hasBusinessInfo ? "Ready" : undefined,
    logo: logo ? "Uploaded" : undefined,
    colors: brandColor ? "Set" : undefined,
    templates: selectedTemplate ? "Selected" : undefined,
    preview: "Live",
  };
  const brandingLinks = BRANDING_SECTIONS.map((section) => ({
    id: `branding-${section.id}`,
    label: section.title,
    hint: section.description,
  }));

  const moveTemplate = (offset: -1 | 1) => {
    const nextIndex = (selectedTemplateIndex + offset + QUOTE_TEMPLATE_OPTIONS.length) % QUOTE_TEMPLATE_OPTIONS.length;
    setSelectedTemplate(QUOTE_TEMPLATE_OPTIONS[nextIndex].id);
  };

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
    if (!effectiveTenantId) return;

    setIsSaving(true);
    setSaveStatus("idle");
    setSaveErrorMessage(null);

    try {
      const componentColorPayload = Object.keys(componentColors).length > 0 ? componentColors : null;

      const result = await api.branding.save(effectiveTenantId, {
        logoUrl: logo ?? null,
        logoPosition,
        hideQuoteFlyAttribution,
        primaryColor: brandColor,
        templateId: selectedTemplate,
        timezone,
        businessProfile: normalizeBusinessProfileForSave(businessProfile),
        componentColors: componentColorPayload,
      });

      setCompanyName(result.tenant.name);
      setTimezone(result.tenant.timezone === "UTC" ? browserTimezone : result.tenant.timezone);
      setBrandColor(result.branding.primaryColor);
      setSelectedTemplate(normalizeQuoteTemplateId(result.branding.templateId));
      setLogo(result.branding.logoUrl ?? null);
      setLogoPosition(result.branding.logoPosition ?? "left");
      setHideQuoteFlyAttribution(Boolean(result.branding.hideQuoteFlyAttribution));
      setComponentColors(result.branding.componentColors ?? {});
      setBusinessProfile(normalizeBusinessProfile(result.branding));

      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveErrorMessage(err instanceof ApiError ? err.message : "Failed to save branding.");
      console.error("Failed to save branding:", err instanceof ApiError ? err.message : err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setSaveStatus("error");
      setSaveErrorMessage("Logo file is too large. Keep it under 8 MB before upload.");
      return;
    }

    try {
      const normalizedLogo = await resizeLogoFile(file);
      setLogo(normalizedLogo);
      setSaveStatus("idle");
      setSaveErrorMessage(null);
    } catch (err) {
      setSaveStatus("error");
      setSaveErrorMessage(err instanceof Error ? err.message : "Could not process logo file.");
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
    .join(" / ");
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
    headerTextColor: getComponentColorValue("headerTextColor"),
    sectionTitleColor: getComponentColorValue("sectionTitleColor"),
    tableHeaderBgColor: getComponentColorValue("tableHeaderBgColor"),
    tableHeaderTextColor: getComponentColorValue("tableHeaderTextColor"),
    totalsColor: getComponentColorValue("totalsColor"),
    footerTextColor: getComponentColorValue("footerTextColor"),
  };
  const activeTemplateSummaryCard = (
    <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-4 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{activeTemplate.name}</p>
          <p className="mt-1 text-sm text-slate-600">{activeTemplate.description}</p>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Best for: {activeTemplate.bestFor}
          </p>
        </div>
        <div className="hidden sm:block">
          <TemplateMiniPreview template={activeTemplate} active onSelect={() => undefined} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          title="Quote Branding"
          subtitle="Set the sender identity, colors, and template your customers actually see."
          actions={<Badge tone="blue">{completedSectionCount}/4 ready</Badge>}
        />

        <div className="grid gap-4 sm:gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
            <WorkspaceRailCard
              eyebrow="Brand Setup"
              title={companyName}
              description="Manage sender identity, visual styling, and quote layout from one operator surface."
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1">
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Timezone</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{timezone}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Template</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{activeTemplate.name}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Logo</p>
                  {logo ? (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="flex h-11 w-16 items-center justify-center rounded-xl border border-slate-200 bg-white px-2">
                        <img src={logo} alt="Saved logo" className="max-h-8 w-auto max-w-full object-contain" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Active</p>
                        <p className="text-xs text-slate-500">Editor, preview, and PDF</p>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm font-semibold text-slate-900">Not uploaded</p>
                  )}
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Placement</p>
                  <p className="mt-2 text-sm font-semibold capitalize text-slate-900">{logoPosition}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">QuoteFly footer</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    {showQuoteFlyAttribution ? "Visible on quotes" : "Hidden on quotes"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {effectivePlanCode === "starter"
                      ? "Starter always shows QuoteFly attribution."
                      : "Professional and Enterprise can hide it."}
                  </p>
                </div>
              </div>
              <ProgressBar
                value={(completedSectionCount / 4) * 100}
                label="Branding completion"
                hint={`${completedSectionCount}/4 ready`}
                className="mt-4"
              />
              <WorkspaceJumpBar links={brandingLinks} className="mt-4" />
            </WorkspaceRailCard>

            <WorkspaceRailCard
              eyebrow="Save"
              title="Customer-facing output"
              description="Branding changes affect the quote PDF your customer opens, prints, or forwards."
            >
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {BRANDING_SECTIONS.map((section) => {
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
                <Button onClick={handleSave} disabled={isSaving || !effectiveTenantId} loading={isSaving} fullWidth>
                  {isSaving ? "Saving..." : "Save Branding"}
                </Button>
                <div className="min-h-[20px] text-sm">
                  {saveStatus === "saved" ? <span className="font-medium text-quotefly-blue">Saved</span> : null}
                  {saveStatus === "error" ? <span className="font-medium text-red-500">{saveErrorMessage ?? "Save failed"}</span> : null}
                  {!effectiveTenantId ? <span className="text-slate-400">Sign in to save your branding settings.</span> : null}
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  Save applies your logo, template, and colors across the quote editor, live preview, and downloaded PDF.
                </p>
              </div>
            </WorkspaceRailCard>
          </aside>

          <div className="space-y-5">
            <BrandingSectionCard
              id="business"
              title="Business Info"
              description="Customer PDFs use this sender block and footer message."
              icon={Building2}
              isOpen={openSections.business}
              completionLabel={sectionCompletionLabel.business}
              onToggle={() => toggleSection("business")}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Input value={companyName} disabled label="Company Name" className="bg-slate-100 text-slate-700" />
                <Input
                  label="Business Email"
                  type="email"
                  value={businessProfile.businessEmail ?? ""}
                  onChange={(event) => updateBusinessField("businessEmail", event.target.value)}
                  placeholder="office@yourcompany.com"
                />
                <Input
                  label="Business Phone"
                  type="tel"
                  value={businessProfile.businessPhone ?? ""}
                  onChange={(event) => updateBusinessField("businessPhone", event.target.value)}
                  placeholder="(555) 123-4567"
                />
                <div className="md:col-span-2">
                  <Textarea
                    label="Quote Message Template"
                    rows={7}
                    value={businessProfile.quoteMessageTemplate ?? ""}
                    onChange={(event) => updateBusinessField("quoteMessageTemplate", event.target.value)}
                    placeholder={[
                      "Hi {customer_name},",
                      "",
                      "Thanks for the opportunity to quote this project.",
                      "",
                      "Quote: {quote_title}",
                      "Total: {quote_total}",
                      "",
                      "Call: {business_phone}",
                      "Email: {business_email}",
                    ].join("\n")}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Used when QuoteFly opens Email App or Text App. Leave blank to use the default message.
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
                  label="Address Line 1"
                  value={businessProfile.addressLine1 ?? ""}
                  onChange={(event) => updateBusinessField("addressLine1", event.target.value)}
                  placeholder="123 Main Street"
                />
                <Input
                  label="Address Line 2"
                  value={businessProfile.addressLine2 ?? ""}
                  onChange={(event) => updateBusinessField("addressLine2", event.target.value)}
                  placeholder="Suite 200"
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <Input
                      label="City"
                      value={businessProfile.city ?? ""}
                      onChange={(event) => updateBusinessField("city", event.target.value)}
                      placeholder="Charlotte"
                    />
                  </div>
                  <Input
                    label="State"
                      value={businessProfile.state ?? ""}
                      onChange={(event) => updateBusinessField("state", event.target.value)}
                      placeholder="NC"
                  />
                  <Input
                    label="ZIP"
                      value={businessProfile.postalCode ?? ""}
                      onChange={(event) => updateBusinessField("postalCode", event.target.value)}
                      placeholder="28202"
                  />
                </div>
                <div>
                  <div className="mb-1 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <label className="block text-xs font-medium text-slate-600">Timezone</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => setTimezone(browserTimezone)}
                    >
                      <span className="sm:hidden">Use local timezone</span>
                      <span className="hidden sm:inline">Use local timezone ({browserTimezone})</span>
                    </Button>
                  </div>
                  <Select
                    label=""
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    options={timezoneOptions.map((option) => ({ value: option, label: option }))}
                  />
                </div>
                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">QuoteFly footer attribution</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Show a small "Created with QuoteFly" footer at the bottom of customer-facing quotes.
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
                      Show footer
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {effectivePlanCode === "starter"
                      ? "Starter always shows QuoteFly attribution for brand recognition."
                      : "Turn this off if you do not want QuoteFly attribution on customer-facing quotes."}
                  </p>
                </div>
              </div>
            </BrandingSectionCard>

            <BrandingSectionCard
              id="logo"
              title="Logo"
              description="Upload the mark that appears on customer-facing quote PDFs."
              icon={ImageIcon}
              isOpen={openSections.logo}
              completionLabel={sectionCompletionLabel.logo}
              onToggle={() => toggleSection("logo")}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                  {logo ? (
                    <>
                      <div className="flex min-h-[180px] items-center justify-center rounded-xl border-2 border-dashed border-quotefly-primary bg-quotefly-primary/5 p-6">
                        <img src={logo} alt="Your logo" className="max-h-28 max-w-full object-contain" />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" variant="outline" icon={<Upload size={14} />} onClick={() => logoInputRef.current?.click()}>
                          Replace Logo
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setLogo(null)}>
                          Remove Logo
                        </Button>
                        <p className="text-xs leading-5 text-slate-500">
                          Current logo is ready. Save branding to publish it across the quote editor, preview, and PDF.
                        </p>
                      </div>
                    </>
                  ) : (
                    <label className="block">
                      <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                      <div className="cursor-pointer rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition-colors hover:border-quotefly-primary">
                        <Upload size={28} className="mx-auto mb-3 text-slate-400" />
                        <p className="text-sm font-medium text-slate-700">Upload logo</p>
                        <p className="mt-1 text-xs text-slate-400">PNG or JPG, automatically resized for the quote editor and PDF.</p>
                      </div>
                    </label>
                  )}

                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">Logo placement</p>
                    <p className="mt-1 text-sm text-slate-500">
                      Choose where the logo sits in the quote header. The live preview and PDF use the same position.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      {LOGO_POSITION_OPTIONS.map((option) => {
                        const Icon = option.icon;
                        const active = logoPosition === option.value;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setLogoPosition(option.value)}
                            className={`rounded-[20px] border px-4 py-3 text-left transition ${
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
                  <p className="text-sm font-semibold text-slate-900">Logo guidance</p>
                  <ul className="mt-3 space-y-2 text-sm text-slate-600">
                    <li>Use a transparent PNG if possible.</li>
                    <li>Keep the logo wide enough for PDF headers.</li>
                    <li>Test against lighter and darker template headers.</li>
                  </ul>
                  <div className="mt-5 rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current status</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{logo ? "Logo selected" : "No logo selected"}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {logo
                        ? "Your logo should appear in the quote editor header, preview modal, and PDF after you save branding."
                        : "Upload a logo here to brand the quote editor, live preview, and final PDF."}
                    </p>
                  </div>
                </div>
              </div>
            </BrandingSectionCard>

            <BrandingSectionCard
              id="colors"
              title="Colors"
              description="Set the primary brand color and override PDF components only where needed."
              icon={Palette}
              isOpen={openSections.colors}
              completionLabel={sectionCompletionLabel.colors}
              onToggle={() => toggleSection("colors")}
            >
              <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="font-display text-lg font-semibold text-slate-900">Primary Brand Color</h3>

                  <div className="mt-4 space-y-3">
                    <input
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
                    <h3 className="font-display text-lg font-semibold text-slate-900">Component Overrides</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Leave a component unassigned to let it follow your primary brand color.
                    </p>
                  </div>

                  <div className="space-y-4">
                    {COLOR_COMPONENTS.map((component) => {
                      const value = getComponentColorValue(component.key);
                      const hasOverride = componentColors[component.key] !== undefined;
                      const resetLabel =
                        component.key === "footerTextColor" ? "Use neutral default" : "Use brand color";

                      return (
                        <div key={component.key} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-sm font-semibold text-slate-800">{component.label}</p>
                              <p className="text-xs text-slate-500">{component.description}</p>
                            </div>
                            <div className="flex items-center gap-2 self-start sm:self-auto">
                              <input
                                type="color"
                                value={value}
                                onChange={(event) => updateComponentColor(component.key, event.target.value)}
                                className="h-10 w-12 cursor-pointer rounded border border-slate-300"
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
                              className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
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
            </BrandingSectionCard>

            <BrandingSectionCard
              id="templates"
              title="Templates"
              description="Use arrows to browse layouts. The preview updates instantly."
              icon={SwatchBook}
              isOpen={openSections.templates}
              completionLabel={sectionCompletionLabel.templates}
              onToggle={() => toggleSection("templates")}
            >
              <div className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="sm:hidden">
                  {activeTemplateSummaryCard}
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => moveTemplate(-1)}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      aria-label="Previous template"
                    >
                      <ChevronLeft size={16} />
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTemplate(1)}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      aria-label="Next template"
                    >
                      Next
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>

                <div className="hidden items-center gap-3 sm:flex">
                  <button
                    type="button"
                    onClick={() => moveTemplate(-1)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
                    aria-label="Previous template"
                  >
                    <ChevronLeft size={18} />
                  </button>

                  <div className="min-w-0 flex-1">{activeTemplateSummaryCard}</div>

                  <button
                    type="button"
                    onClick={() => moveTemplate(1)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50"
                    aria-label="Next template"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>

                <div className="-mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-1">
                  {QUOTE_TEMPLATE_OPTIONS.map((template) => (
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
              id="preview"
              title="Preview"
              description="Review the customer-facing PDF layout with your sender details."
              icon={Eye}
              isOpen={openSections.preview}
              completionLabel={sectionCompletionLabel.preview}
              onToggle={() => toggleSection("preview")}
            >
              <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-8">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Customer-facing output</p>
                    <p className="mt-1 text-sm text-slate-600">
                      This is the style your customer will open, print, or forward.
                    </p>
                  </div>
                  <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                    {activeTemplate.name}
                  </div>
                </div>
                <QuoteLivePreview
                  businessName={companyName}
                  businessHint={previewBusinessHint || "Add address, phone, or email to show sender details here."}
                  customerName="John Doe"
                  customerPhone="(555) 123-4567"
                  customerEmail="john@example.com"
                  preparedDateLabel="Apr 10, 2026"
                  sentDateLabel="N/A"
                  quoteTitle="Install/replace furnace unit"
                  scopeText="Install new condenser and indoor coil, pressure test the system, verify refrigerant levels, and confirm startup performance."
                  lines={[
                    {
                      id: "preview-line-1",
                      title: "Equipment and installation labor",
                      details: "Includes startup testing, haul-away, and final system checks.",
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
                  quoteReferenceLabel="Quote #12345"
                  subtitle="Customer quote"
                />
              </div>
            </BrandingSectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

