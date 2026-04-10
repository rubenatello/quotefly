import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { setSEOMetadata } from "../lib/seo";
import {
  api,
  ApiError,
  type BrandingBusinessProfile,
  type BrandingComponentColors,
  type BrandingTemplateId,
} from "../lib/api";

interface BrandingPageProps {
  tenantId?: string;
}

type TemplateHeaderStyle = "bar" | "card" | "block" | "minimal";

interface TemplateOption {
  id: BrandingTemplateId;
  name: string;
  description: string;
  preview: string;
  headerStyle: TemplateHeaderStyle;
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
  { key: "sectionTitleColor", label: "Section Titles", description: "Color for section labels like Scope and Customer." },
  { key: "tableHeaderBgColor", label: "Table Header", description: "Line-item table header background color." },
  { key: "totalsColor", label: "Totals", description: "Subtotal, tax, and total emphasis color." },
  { key: "footerTextColor", label: "Footer Text", description: "Footer and metadata text color." },
];

const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: "modern",
    name: "Modern Clean",
    description: "Top bar layout with clean spacing for fast readability.",
    preview: "bg-gradient-to-br from-blue-50 to-slate-50",
    headerStyle: "bar",
  },
  {
    id: "professional",
    name: "Professional",
    description: "Structured card header for a formal business look.",
    preview: "bg-gradient-to-br from-emerald-50 to-slate-50",
    headerStyle: "card",
  },
  {
    id: "bold",
    name: "Bold",
    description: "High-contrast block header that stands out immediately.",
    preview: "bg-gradient-to-br from-orange-50 to-rose-50",
    headerStyle: "block",
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Minimal ink style for no-friction, text-first quoting.",
    preview: "bg-white",
    headerStyle: "minimal",
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced card style with a timeless proposal feel.",
    preview: "bg-gradient-to-br from-amber-50 to-stone-100",
    headerStyle: "card",
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

export function BrandingPage({ tenantId }: BrandingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Quote Branding - Customize Your Quotes | QuoteFly",
      description:
        "Upload your logo, choose colors, set business sender info, and customize quote templates to match your brand.",
      keywords: "quote branding, custom quote templates, contractor branding, sender business info",
    });
  }, []);

  const browserTimezone = useMemo(() => getBrowserTimezone(), []);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);

  const [companyName, setCompanyName] = useState("QuoteFly Services");
  const [logo, setLogo] = useState<string | null>(null);
  const [brandColor, setBrandColor] = useState("#5B85AA");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [businessProfile, setBusinessProfile] = useState<BrandingBusinessProfile>(EMPTY_BUSINESS_PROFILE);
  const [selectedTemplate, setSelectedTemplate] = useState<BrandingTemplateId>("modern");
  const [componentColors, setComponentColors] = useState<BrandingComponentColors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    if (!tenantId) return;

    api.branding
      .get(tenantId)
      .then(({ tenant, branding }) => {
        setCompanyName(tenant.name);
        setTimezone(tenant.timezone === "UTC" ? browserTimezone : tenant.timezone);

        if (!branding) return;

        setBrandColor(branding.primaryColor);
        setSelectedTemplate(branding.templateId);
        setComponentColors(branding.componentColors ?? {});
        setBusinessProfile(normalizeBusinessProfile(branding));
        if (branding.logoUrl) {
          setLogo(branding.logoUrl);
        }
      })
      .catch(() => {
        // Silently ignore while auth/session is not ready yet.
      });
  }, [browserTimezone, tenantId]);

  const selectedTemplateIndex = useMemo(() => {
    const index = TEMPLATE_OPTIONS.findIndex((template) => template.id === selectedTemplate);
    return index >= 0 ? index : 0;
  }, [selectedTemplate]);

  const activeTemplate = TEMPLATE_OPTIONS[selectedTemplateIndex];
  const businessAddressLines = formatBusinessAddress(businessProfile);

  const moveTemplate = (offset: -1 | 1) => {
    const nextIndex = (selectedTemplateIndex + offset + TEMPLATE_OPTIONS.length) % TEMPLATE_OPTIONS.length;
    setSelectedTemplate(TEMPLATE_OPTIONS[nextIndex].id);
  };

  const handleSave = async () => {
    if (!tenantId) return;

    setIsSaving(true);
    setSaveStatus("idle");

    try {
      const componentColorPayload = Object.keys(componentColors).length > 0 ? componentColors : null;

      await api.branding.save(tenantId, {
        logoUrl: logo ?? null,
        primaryColor: brandColor,
        templateId: selectedTemplate,
        timezone,
        businessProfile,
        componentColors: componentColorPayload,
      });

      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      console.error("Failed to save branding:", err instanceof ApiError ? err.message : err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (readerEvent) => {
      setLogo(readerEvent.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const getComponentFallback = (key: keyof BrandingComponentColors): string =>
    key === "footerTextColor" ? "#666666" : brandColor;

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
  const previewSectionTitleColor = getComponentColorValue("sectionTitleColor");
  const previewTableHeaderColor = getComponentColorValue("tableHeaderBgColor");
  const previewTotalsColor = getComponentColorValue("totalsColor");
  const previewFooterColor = getComponentColorValue("footerTextColor");

  return (
    <div className="min-h-screen bg-stone-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="mb-2 text-4xl font-bold font-display text-slate-900">Quote Branding</h1>
          <p className="text-lg text-slate-500">
            Set the sender identity, timezone, colors, and template your customers will actually see.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-1">
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-2 font-display font-semibold text-slate-900">Business Profile</h2>
              <p className="mb-4 text-xs text-slate-500">
                Customer PDFs will use this sender information. Timezone controls the local date shown on quotes.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Company Name</label>
                  <input
                    value={companyName}
                    disabled
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Business Email</label>
                  <input
                    type="email"
                    value={businessProfile.businessEmail ?? ""}
                    onChange={(event) => updateBusinessField("businessEmail", event.target.value)}
                    placeholder="office@yourcompany.com"
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Business Phone</label>
                  <input
                    type="tel"
                    value={businessProfile.businessPhone ?? ""}
                    onChange={(event) => updateBusinessField("businessPhone", event.target.value)}
                    placeholder="(555) 123-4567"
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Address Line 1</label>
                  <input
                    value={businessProfile.addressLine1 ?? ""}
                    onChange={(event) => updateBusinessField("addressLine1", event.target.value)}
                    placeholder="123 Main Street"
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Address Line 2</label>
                  <input
                    value={businessProfile.addressLine2 ?? ""}
                    onChange={(event) => updateBusinessField("addressLine2", event.target.value)}
                    placeholder="Suite 200"
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <label className="mb-1 block text-xs font-medium text-slate-600">City</label>
                    <input
                      value={businessProfile.city ?? ""}
                      onChange={(event) => updateBusinessField("city", event.target.value)}
                      placeholder="Charlotte"
                      className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">State</label>
                    <input
                      value={businessProfile.state ?? ""}
                      onChange={(event) => updateBusinessField("state", event.target.value)}
                      placeholder="NC"
                      className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">ZIP</label>
                    <input
                      value={businessProfile.postalCode ?? ""}
                      onChange={(event) => updateBusinessField("postalCode", event.target.value)}
                      placeholder="28202"
                      className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <label className="block text-xs font-medium text-slate-600">Timezone</label>
                    <button
                      type="button"
                      onClick={() => setTimezone(browserTimezone)}
                      className="text-xs font-medium text-quotefly-primary hover:text-blue-700"
                    >
                      Use local timezone ({browserTimezone})
                    </button>
                  </div>
                  <select
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  >
                    {timezoneOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Your Logo</h2>

              <div className="mb-4">
                {logo ? (
                  <div className="mb-4 flex h-32 items-center justify-center rounded-lg border-2 border-dashed border-quotefly-primary bg-quotefly-primary/5 p-4">
                    <img src={logo} alt="Your logo" className="max-h-full max-w-full object-contain" />
                  </div>
                ) : (
                  <label className="block">
                    <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                    <div className="cursor-pointer rounded-lg border-2 border-dashed border-slate-300 p-6 text-center transition-colors hover:border-quotefly-primary">
                      <Upload size={24} className="mx-auto mb-2 text-slate-400" />
                      <p className="text-sm font-medium text-slate-700">Click to upload logo</p>
                      <p className="mt-1 text-xs text-slate-400">PNG, JPG up to 5MB</p>
                    </div>
                  </label>
                )}
              </div>

              {logo && (
                <button
                  onClick={() => setLogo(null)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:text-slate-900"
                >
                  Remove Logo
                </button>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Brand Color</h2>

              <div className="space-y-3">
                <input
                  type="color"
                  value={brandColor}
                  onChange={(event) => setBrandColor(event.target.value)}
                  className="h-12 w-full cursor-pointer rounded-lg"
                />
                <p className="text-center text-xs text-slate-500">{brandColor}</p>
                <div style={{ backgroundColor: brandColor }} className="h-16 rounded-lg border border-slate-200" />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Component Colors</h2>
              <p className="mb-4 text-xs text-slate-500">
                Leave a component unassigned to let it follow your primary brand color.
              </p>

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

          <div className="lg:col-span-2">
            <div className="mb-6">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Quote Templates</h2>
              <p className="mb-4 text-sm text-slate-500">
                Use arrows to browse templates. Preview updates instantly and includes the sender block your customer will see.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => moveTemplate(-1)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  aria-label="Previous template"
                >
                  <ChevronLeft size={18} />
                </button>

                <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{activeTemplate.name}</p>
                      <p className="mt-1 text-xs text-slate-600">{activeTemplate.description}</p>
                    </div>
                    <div className={`h-14 w-24 rounded-md border border-slate-200 ${activeTemplate.preview}`} />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => moveTemplate(1)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  aria-label="Next template"
                >
                  <ChevronRight size={18} />
                </button>
              </div>

              <div className="mt-3 flex items-center justify-center gap-2">
                {TEMPLATE_OPTIONS.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setSelectedTemplate(template.id)}
                    aria-label={`Select ${template.name} template`}
                    className={`h-2.5 rounded-full transition-all ${
                      selectedTemplate === template.id
                        ? "w-6 bg-quotefly-primary"
                        : "w-2.5 bg-slate-300 hover:bg-slate-400"
                    }`}
                  />
                ))}
              </div>
            </div>

            <div className="mt-8 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
              <h3 className="mb-4 font-display font-semibold text-slate-900">Preview</h3>

              <div className={`rounded-lg p-8 text-black shadow-lg ${activeTemplate.preview}`}>
                {activeTemplate.headerStyle === "bar" && (
                  <div className="mb-6 rounded-lg p-4 text-white" style={{ backgroundColor: previewHeaderColor }}>
                    <div className="flex items-start justify-between">
                      <div>
                        {logo ? (
                          <img src={logo} alt="Logo" className="mb-2 h-12 rounded bg-white p-1" />
                        ) : (
                          <div className="mb-2 h-12 w-12 rounded bg-white/20" />
                        )}
                        <h4 className="mt-2 text-lg font-bold">{companyName}</h4>
                      </div>
                      <div className="text-right text-sm">
                        <p className="font-semibold">Quote #12345</p>
                        <p className="text-white/80">April 10, 2026</p>
                      </div>
                    </div>
                  </div>
                )}

                {activeTemplate.headerStyle === "card" && (
                  <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        {logo ? (
                          <img src={logo} alt="Logo" className="h-10 rounded bg-slate-100 p-1" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-slate-200" />
                        )}
                        <div>
                          <p className="text-base font-semibold" style={{ color: previewHeaderColor }}>
                            {companyName}
                          </p>
                          <p className="text-xs text-slate-500">Quote #12345</p>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500">April 10, 2026</p>
                    </div>
                  </div>
                )}

                {activeTemplate.headerStyle === "block" && (
                  <div className="mb-6 rounded-lg p-5 text-white" style={{ backgroundColor: previewHeaderColor }}>
                    <div className="flex items-center justify-between">
                      <h4 className="text-xl font-bold tracking-wide">{companyName}</h4>
                      <p className="text-sm">Quote #12345</p>
                    </div>
                    <p className="mt-2 text-sm text-white/80">Prepared on April 10, 2026</p>
                  </div>
                )}

                {activeTemplate.headerStyle === "minimal" && (
                  <div className="mb-6 border-b border-slate-300 pb-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-lg font-semibold" style={{ color: previewHeaderColor }}>
                        {companyName}
                      </h4>
                      <p className="text-xs text-slate-500">Quote #12345</p>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">Customer-facing quote preview</p>
                  </div>
                )}

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
                    <tr style={{ backgroundColor: previewTableHeaderColor }}>
                      <th className="py-2 pl-2 text-left font-semibold text-white">Description</th>
                      <th className="py-2 pr-2 text-right font-semibold text-white">Amount</th>
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
                  className={`rounded p-4 text-center font-semibold ${activeTemplate.headerStyle === "minimal" ? "border border-slate-300 text-slate-700" : "text-white"}`}
                  style={{ backgroundColor: activeTemplate.headerStyle === "minimal" ? "#ffffff" : previewHeaderColor }}
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

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={handleSave}
                disabled={isSaving || !tenantId}
                className="flex-1 rounded-lg bg-quotefly-primary px-6 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Branding and Sender Info"}
              </button>
              {saveStatus === "saved" && <span className="text-sm font-medium text-green-500">Saved</span>}
              {saveStatus === "error" && <span className="text-sm font-medium text-red-500">Save failed</span>}
            </div>
            {!tenantId && (
              <p className="mt-2 text-center text-xs text-slate-400">Sign in to save your branding settings.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
