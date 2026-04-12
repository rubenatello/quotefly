import { useEffect, useMemo, useState } from "react";
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
import {
  api,
  ApiError,
  type BrandingBusinessProfile,
  type BrandingComponentColors,
  type BrandingLogoPosition,
  type BrandingTemplateId,
} from "../lib/api";
import { Badge, Button, Input, PageHeader, ProgressBar, Select } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceRailCard } from "../components/ui/workspace";

interface BrandingPageProps {
  tenantId?: string;
}

type BrandingSectionId = "business" | "logo" | "colors" | "templates" | "preview";
type TemplateHeaderStyle = "bar" | "card" | "block" | "minimal";

interface TemplateOption {
  id: BrandingTemplateId;
  name: string;
  description: string;
  preview: string;
  headerStyle: TemplateHeaderStyle;
  bestFor: string;
}

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

const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: "modern",
    name: "Modern Clean",
    description: "Top bar layout with clean spacing for fast readability.",
    preview: "bg-white",
    headerStyle: "bar",
    bestFor: "Fast field quotes",
  },
  {
    id: "professional",
    name: "Professional",
    description: "Structured card header for a formal business look.",
    preview: "bg-slate-50",
    headerStyle: "card",
    bestFor: "Office-ready estimates",
  },
  {
    id: "bold",
    name: "Bold",
    description: "High-contrast block header that stands out immediately.",
    preview: "bg-slate-100",
    headerStyle: "block",
    bestFor: "Sales-forward proposals",
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Minimal ink style for no-friction, text-first quoting.",
    preview: "bg-white",
    headerStyle: "minimal",
    bestFor: "Clean no-frills estimates",
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced card style with a timeless proposal feel.",
    preview: "bg-orange-50",
    headerStyle: "card",
    bestFor: "Traditional contractors",
  },
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
  template: TemplateOption;
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
        ) : template.headerStyle === "block" ? (
          <>
            <div className="rounded-2xl bg-slate-900 p-3">
              <div className="mb-2 h-1.5 w-full rounded-full bg-quotefly-orange" />
              <div className="h-2 w-1/2 rounded-full bg-white/90" />
              <div className="mt-2 h-2 w-1/3 rounded-full bg-white/55" />
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

function PreviewQuoteHeader({
  template,
  companyName,
  logo,
  logoPosition,
  headerColor,
  headerTextColor,
}: {
  template: TemplateOption;
  companyName: string;
  logo: string | null;
  logoPosition: BrandingLogoPosition;
  headerColor: string;
  headerTextColor: string;
}) {
  const logoRowClass =
    logoPosition === "center"
      ? "justify-center"
      : logoPosition === "right"
        ? "justify-end"
        : "justify-start";
  const contentAlignClass =
    logoPosition === "center"
      ? "items-center text-center"
      : logoPosition === "right"
        ? "items-end text-right"
        : "items-start text-left";
  const headingColor = template.headerStyle === "block" ? headerTextColor : "#0f172a";
  const subtitleColor =
    template.headerStyle === "block" ? "text-white/70" : "text-slate-500";
  const metaToneClass =
    template.headerStyle === "block" ? "text-white/75 border-white/15" : "text-slate-500 border-slate-200";

  return (
    <div
      className={`mb-6 overflow-hidden ${
        template.headerStyle === "minimal"
          ? "border-b border-slate-300 pb-5"
          : template.headerStyle === "block"
            ? "rounded-[24px] border border-slate-900/10 shadow-sm"
            : "rounded-[24px] border border-slate-200 shadow-sm"
      } ${template.headerStyle === "card" ? "bg-slate-50" : "bg-white"}`}
      style={template.headerStyle === "block" ? { backgroundColor: headerColor } : undefined}
    >
      {template.headerStyle === "bar" ? (
        <div className="h-1.5" style={{ backgroundColor: headerColor }} />
      ) : null}

      <div className={`relative px-5 py-5 sm:px-6 ${template.headerStyle === "card" ? "sm:pl-9" : ""}`}>
        {template.headerStyle === "card" ? (
          <div
            className="absolute bottom-5 left-5 top-5 hidden w-1 rounded-full sm:block"
            style={{ backgroundColor: headerColor }}
          />
        ) : null}

        <div className={`flex ${logoRowClass}`}>
          {logo ? (
            <img
              src={logo}
              alt="Logo"
              className={`object-contain ${template.headerStyle === "minimal" ? "h-10 max-w-[120px]" : "h-12 max-w-[140px]"} rounded bg-white/90 p-1.5`}
            />
          ) : (
            <div className={`rounded-2xl border border-dashed ${template.headerStyle === "block" ? "border-white/30 bg-white/10" : "border-slate-200 bg-slate-50"} h-12 w-12`} />
          )}
        </div>

        <div className={`mt-4 flex flex-col ${contentAlignClass}`}>
          <h4
            className={`font-display ${template.headerStyle === "minimal" ? "text-[1.25rem]" : "text-[1.45rem]"} font-semibold tracking-tight`}
            style={{ color: headingColor }}
          >
            {companyName}
          </h4>
          <p className={`mt-1 text-sm ${subtitleColor}`}>Customer quote</p>
        </div>

        <div className={`mt-5 flex items-center justify-between gap-4 border-t pt-3 text-[12px] font-medium ${metaToneClass}`}>
          <span>Prepared April 10, 2026</span>
          <span>Quote #12345</span>
        </div>
      </div>
    </div>
  );
}

export function BrandingPage({ tenantId }: BrandingPageProps) {
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
  const [brandColor, setBrandColor] = useState("#5B85AA");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [businessProfile, setBusinessProfile] = useState<BrandingBusinessProfile>(EMPTY_BUSINESS_PROFILE);
  const [selectedTemplate, setSelectedTemplate] = useState<BrandingTemplateId>("modern");
  const [componentColors, setComponentColors] = useState<BrandingComponentColors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<BrandingSectionId, boolean>>({
    business: true,
    logo: false,
    colors: false,
    templates: true,
    preview: true,
  });

  useEffect(() => {
    if (!effectiveTenantId) return;

    api.branding
      .get(effectiveTenantId)
      .then(({ tenant, branding }) => {
        setCompanyName(tenant.name);
        setTimezone(tenant.timezone === "UTC" ? browserTimezone : tenant.timezone);

        if (!branding) return;

        setBrandColor(branding.primaryColor);
        setSelectedTemplate(branding.templateId);
        setLogoPosition(branding.logoPosition ?? "left");
        setComponentColors(branding.componentColors ?? {});
        setBusinessProfile(normalizeBusinessProfile(branding));
        if (branding.logoUrl) {
          setLogo(branding.logoUrl);
        }
      })
      .catch(() => {
        // Silently ignore while auth/session is not ready yet.
      });
  }, [browserTimezone, effectiveTenantId]);

  const selectedTemplateIndex = useMemo(() => {
    const index = TEMPLATE_OPTIONS.findIndex((template) => template.id === selectedTemplate);
    return index >= 0 ? index : 0;
  }, [selectedTemplate]);

  const activeTemplate = TEMPLATE_OPTIONS[selectedTemplateIndex];
  const businessAddressLines = formatBusinessAddress(businessProfile);
  const hasBusinessInfo = Boolean(
    businessProfile.businessEmail?.trim() ||
      businessProfile.businessPhone?.trim() ||
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
    const nextIndex = (selectedTemplateIndex + offset + TEMPLATE_OPTIONS.length) % TEMPLATE_OPTIONS.length;
    setSelectedTemplate(TEMPLATE_OPTIONS[nextIndex].id);
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

      await api.branding.save(effectiveTenantId, {
        logoUrl: logo ?? null,
        logoPosition,
        primaryColor: brandColor,
        templateId: selectedTemplate,
        timezone,
        businessProfile: normalizeBusinessProfileForSave(businessProfile),
        componentColors: componentColorPayload,
      });

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
  const previewHeaderTextColor = getComponentColorValue("headerTextColor");
  const previewSectionTitleColor = getComponentColorValue("sectionTitleColor");
  const previewTableHeaderColor = getComponentColorValue("tableHeaderBgColor");
  const previewTableHeaderTextColor = getComponentColorValue("tableHeaderTextColor");
  const previewTotalsColor = getComponentColorValue("totalsColor");
  const previewFooterColor = getComponentColorValue("footerTextColor");

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          title="Quote Branding"
          subtitle="Set the sender identity, colors, and template your customers actually see."
          actions={<Badge tone="blue">{completedSectionCount}/4 ready</Badge>}
        />

        <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
            <WorkspaceRailCard
              eyebrow="Brand Setup"
              title={companyName}
              description="Manage sender identity, visual styling, and quote layout from one operator surface."
            >
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
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
                  <p className="mt-2 text-sm font-semibold text-slate-900">{logo ? "Uploaded" : "Optional"}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Placement</p>
                  <p className="mt-2 text-sm font-semibold capitalize text-slate-900">{logoPosition}</p>
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
              </div>
            </WorkspaceRailCard>
          </aside>

          <div className="space-y-5">
            <BrandingSectionCard
              id="business"
              title="Business Info"
              description="Customer PDFs use this sender block and timezone."
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
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <label className="block text-xs font-medium text-slate-600">Timezone</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTimezone(browserTimezone)}
                    >
                      Use local timezone ({browserTimezone})
                    </Button>
                  </div>
                  <Select
                    label=""
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    options={timezoneOptions.map((option) => ({ value: option, label: option }))}
                  />
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
                  {logo ? (
                    <div className="flex min-h-[180px] items-center justify-center rounded-xl border-2 border-dashed border-quotefly-primary bg-quotefly-primary/5 p-6">
                      <img src={logo} alt="Your logo" className="max-h-28 max-w-full object-contain" />
                    </div>
                  ) : (
                    <label className="block">
                      <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                      <div className="cursor-pointer rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition-colors hover:border-quotefly-primary">
                        <Upload size={28} className="mx-auto mb-3 text-slate-400" />
                        <p className="text-sm font-medium text-slate-700">Click to upload logo</p>
                        <p className="mt-1 text-xs text-slate-400">PNG, JPG up to 5MB</p>
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
                  {logo && (
                    <Button
                      onClick={() => setLogo(null)}
                      variant="outline"
                      fullWidth
                      className="mt-5"
                    >
                      Remove Logo
                    </Button>
                  )}
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
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-800">{component.label}</p>
                              <p className="text-xs text-slate-500">{component.description}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={value}
                                onChange={(event) => updateComponentColor(component.key, event.target.value)}
                                className="h-10 w-12 cursor-pointer rounded border border-slate-300"
                              />
                              <span className="w-20 text-right font-mono text-xs text-slate-500">{value}</span>
                            </div>
                          </div>

                          <div className="mt-3 flex items-center justify-between gap-3">
                            <div className="h-2 flex-1 rounded" style={{ backgroundColor: value }} />
                            <button
                              type="button"
                              onClick={() => clearComponentColorOverride(component.key)}
                              disabled={!hasOverride}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
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
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => moveTemplate(-1)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
                    aria-label="Previous template"
                  >
                    <ChevronLeft size={18} />
                  </button>

                  <div className="flex-1 rounded-[24px] border border-slate-200 bg-slate-50 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
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
                  {TEMPLATE_OPTIONS.map((template) => (
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
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-black">
                <PreviewQuoteHeader
                  template={activeTemplate}
                  companyName={companyName}
                  logo={logo}
                  logoPosition={logoPosition}
                  headerColor={previewHeaderColor}
                  headerTextColor={previewHeaderTextColor}
                />

                <div className="mb-6 grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-white/70 p-4">
                    <h5 className="mb-2 font-semibold" style={{ color: previewSectionTitleColor }}>
                      From
                    </h5>
                    <p className="text-sm font-semibold text-slate-900">{companyName}</p>
                    {businessAddressLines.length > 0 ? (
                      businessAddressLines.map((line) => (
                        <p key={line} className="text-sm text-slate-600">{line}</p>
                      ))
                    ) : (
                      <p className="text-sm text-slate-500">Add business address to show sender details here.</p>
                    )}
                    {businessProfile.businessPhone ? (
                      <p className="text-sm text-slate-600">{businessProfile.businessPhone}</p>
                    ) : null}
                    {businessProfile.businessEmail ? (
                      <p className="text-sm text-slate-600">{businessProfile.businessEmail}</p>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white/70 p-4">
                    <h5 className="mb-2 font-semibold" style={{ color: previewSectionTitleColor }}>
                      Prepared For
                    </h5>
                    <p className="text-sm font-semibold text-slate-900">John Doe</p>
                    <p className="text-sm text-slate-600">john@example.com</p>
                    <p className="text-sm text-slate-600">(555) 123-4567</p>
                  </div>
                </div>

                <div className="mb-6">
                  <h5 className="mb-2 font-semibold" style={{ color: previewSectionTitleColor }}>
                    Scope of Work
                  </h5>
                  <p className="text-sm text-slate-600">
                    Install new condenser and indoor coil, pressure test the system, verify refrigerant levels, and confirm startup performance.
                  </p>
                </div>

                <table className="mb-6 w-full text-sm">
                  <thead>
                    <tr style={{ backgroundColor: previewTableHeaderColor, color: previewTableHeaderTextColor }}>
                      <th className="py-2 pl-2 text-left font-semibold">Description</th>
                      <th className="py-2 pr-2 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-200">
                      <td className="py-2">Equipment and installation labor</td>
                      <td className="text-right">$2,450.00</td>
                    </tr>
                    <tr>
                      <td className="py-2 font-semibold">Total</td>
                      <td className="text-right font-semibold" style={{ color: previewTotalsColor }}>
                        $2,450.00
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div
                  className="rounded-lg border px-4 py-4 text-center font-semibold text-slate-700"
                  style={{ borderColor: previewHeaderColor }}
                >
                  Valid for 30 days
                </div>

                <p className="mt-4 text-center text-xs" style={{ color: previewFooterColor }}>
                  Questions about this quote? Contact {companyName}
                  {businessProfile.businessPhone ? ` at ${businessProfile.businessPhone}` : ""}
                  {businessProfile.businessEmail ? ` or ${businessProfile.businessEmail}` : ""} / Timezone: {timezone}
                </p>
              </div>
              </div>
            </BrandingSectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

