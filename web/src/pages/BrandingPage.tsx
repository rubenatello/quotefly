import { useEffect, useState } from "react";
import { setSEOMetadata } from "../lib/seo";
import { Upload } from "lucide-react";
import { api, ApiError, type BrandingComponentColors, type BrandingTemplateId } from "../lib/api";

interface BrandingPageProps {
  tenantId?: string;
}

const COLOR_COMPONENTS: Array<{ key: keyof BrandingComponentColors; label: string; description: string }> = [
  { key: "headerBgColor", label: "Header Background", description: "Top header block color in the PDF quote." },
  { key: "sectionTitleColor", label: "Section Titles", description: "Color for section labels like Scope/Customer." },
  { key: "tableHeaderBgColor", label: "Table Header", description: "Line-item table header background color." },
  { key: "totalsColor", label: "Totals", description: "Subtotal/Tax/Total emphasis color." },
  { key: "footerTextColor", label: "Footer Text", description: "Footer and metadata text color." },
];

export function BrandingPage({ tenantId }: BrandingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Quote Branding - Customize Your Quotes | QuoteFly",
      description:
        "Upload your logo, choose colors, and customize quote templates to match your brand. Create professional quotes in seconds.",
      keywords: "quote branding, custom quote templates, contractor branding",
    });
  }, []);

  const [logo, setLogo] = useState<string | null>(null);
  const [brandColor, setBrandColor] = useState("#5B85AA");
  const [selectedTemplate, setSelectedTemplate] = useState<BrandingTemplateId>("modern");
  const [componentColors, setComponentColors] = useState<BrandingComponentColors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    if (!tenantId) return;

    api.branding
      .get(tenantId)
      .then(({ branding }) => {
        if (!branding) return;

        setBrandColor(branding.primaryColor);
        setSelectedTemplate(branding.templateId);
        setComponentColors(branding.componentColors ?? {});
        if (branding.logoUrl) {
          setLogo(branding.logoUrl);
        }
      })
      .catch(() => {
        // Silently ignore while auth/session is not ready yet.
      });
  }, [tenantId]);

  const handleSave = async () => {
    if (!tenantId) return;

    setIsSaving(true);
    setSaveStatus("idle");

    try {
      const componentColorPayload =
        Object.keys(componentColors).length > 0 ? componentColors : null;

      await api.branding.save(tenantId, {
        logoUrl: logo ?? null,
        primaryColor: brandColor,
        templateId: selectedTemplate,
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

  const templates: Array<{
    id: BrandingTemplateId;
    name: string;
    description: string;
    preview: string;
  }> = [
    {
      id: "modern",
      name: "Modern Clean",
      description: "Minimalist design with focus on the quote details",
      preview: "bg-gradient-to-br from-blue-50 to-slate-50",
    },
    {
      id: "professional",
      name: "Professional",
      description: "Traditional format with your logo prominently displayed",
      preview: "bg-gradient-to-br from-slate-50 to-slate-100",
    },
    {
      id: "bold",
      name: "Bold & Vibrant",
      description: "Eye-catching design that stands out",
      preview: "bg-gradient-to-br from-indigo-50 to-purple-50",
    },
    {
      id: "minimal",
      name: "Ultra Minimal",
      description: "Clean, text-focused design for maximum flexibility",
      preview: "bg-white",
    },
    {
      id: "classic",
      name: "Classic",
      description: "Traditional proposal styling with warm accents",
      preview: "bg-gradient-to-br from-amber-50 to-stone-100",
    },
  ];

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setLogo(event.target?.result as string);
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
            Make every quote your own. Upload your logo, pick your colors, choose a template.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-1">
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
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="h-12 w-full cursor-pointer rounded-lg"
                />
                <p className="text-center text-xs text-slate-500">{brandColor}</p>

                <div style={{ backgroundColor: brandColor }} className="h-16 rounded-lg border border-zinc-700" />
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
                            onChange={(e) => updateComponentColor(component.key, e.target.value)}
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
                Choose how your quotes look. You can customize further after selection.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => setSelectedTemplate(template.id)}
                  className={`rounded-lg border p-4 transition-all ${
                    selectedTemplate === template.id
                      ? "border-quotefly-primary bg-quotefly-primary/5 ring-2 ring-quotefly-primary"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className={`${template.preview} mb-3 h-32 rounded-lg border border-slate-200`} />
                  <h3 className="text-left font-semibold text-slate-900">{template.name}</h3>
                  <p className="mt-1 text-left text-xs text-slate-500">{template.description}</p>
                </button>
              ))}
            </div>

            <div className="mt-8 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
              <h3 className="mb-4 font-display font-semibold text-slate-900">Preview</h3>

              <div className="rounded-lg bg-white p-8 text-black shadow-lg">
                <div className="mb-6 rounded-lg p-4 text-white" style={{ backgroundColor: previewHeaderColor }}>
                  <div className="flex items-start justify-between">
                    <div>
                      {logo ? (
                        <img src={logo} alt="Logo" className="mb-2 h-12 rounded bg-white p-1" />
                      ) : (
                        <div className="mb-2 h-12 w-12 rounded bg-white/20" />
                      )}
                      <h4 className="mt-2 text-lg font-bold">QUOTE</h4>
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-semibold">Quote #12345</p>
                      <p className="text-white/80">April 9, 2026</p>
                    </div>
                  </div>
                </div>

                <div className="mb-6">
                  <h5 className="mb-2 font-semibold" style={{ color: previewSectionTitleColor }}>
                    Customer Details
                  </h5>
                  <p className="text-sm text-gray-600">John Doe | john@example.com | (555) 123-4567</p>
                </div>

                <table className="mb-6 w-full text-sm">
                  <thead>
                    <tr style={{ backgroundColor: previewTableHeaderColor }}>
                      <th className="py-2 pl-2 text-left font-semibold text-white">Description</th>
                      <th className="py-2 pr-2 text-right font-semibold text-white">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">Professional HVAC Installation</td>
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

                <div className="rounded p-4 text-center font-semibold text-white" style={{ backgroundColor: previewHeaderColor }}>
                  Valid for 30 days
                </div>

                <p className="mt-4 text-center text-xs" style={{ color: previewFooterColor }}>
                  Footer text and metadata coloring preview
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={handleSave}
                disabled={isSaving || !tenantId}
                className="flex-1 rounded-lg bg-quotefly-primary px-6 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Branding & Templates"}
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
