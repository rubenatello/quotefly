import { useEffect, useState } from "react";
import { setSEOMetadata } from "../lib/seo";
import { Upload } from "lucide-react";
import { api, ApiError, type BrandingTemplateId } from "../lib/api";

interface BrandingPageProps {
  tenantId?: string;
}

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
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  // Load saved branding on mount if we have a tenant
  useEffect(() => {
    if (!tenantId) return;
    api.branding.get(tenantId).then(({ branding }) => {
      if (branding) {
        setBrandColor(branding.primaryColor);
        setSelectedTemplate(branding.templateId);
        if (branding.logoUrl) setLogo(branding.logoUrl);
      }
    }).catch(() => {/* silently ignore — user may not be authenticated yet */});
  }, [tenantId]);

  const handleSave = async () => {
    if (!tenantId) return;
    setIsSaving(true);
    setSaveStatus("idle");
    try {
      await api.branding.save(tenantId, {
        logoUrl: logo ?? null,
        primaryColor: brandColor,
        templateId: selectedTemplate,
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
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setLogo(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="mb-2 text-4xl font-bold font-display text-slate-900">Quote Branding</h1>
          <p className="text-lg text-slate-500">Make every quote your own. Upload your logo, pick your colors, choose a template.</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Left Panel: Logo & Colors */}
          <div className="space-y-6 lg:col-span-1">
            {/* Logo Upload */}
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Your Logo</h2>

              <div className="mb-4">
                {logo ? (
                  <div className="mb-4 rounded-lg border-2 border-quotefly-primary border-dashed p-4 bg-quotefly-primary/5 flex items-center justify-center h-32">
                    <img src={logo} alt="Your logo" className="max-h-full max-w-full object-contain" />
                  </div>
                ) : (
                  <label className="block">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="hidden"
                    />
                    <div className="cursor-pointer rounded-lg border-2 border-dashed border-slate-300 p-6 hover:border-quotefly-primary transition-colors text-center">
                      <Upload size={24} className="mx-auto mb-2 text-slate-400" />
                      <p className="text-sm font-medium text-slate-700">Click to upload logo</p>
                      <p className="text-xs text-slate-400 mt-1">PNG, JPG up to 5MB</p>
                    </div>
                  </label>
                )}
              </div>

              {logo && (
                <button
                  onClick={() => setLogo(null)}
                  className="w-full px-3 py-2 text-sm text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg transition-colors"
                >
                  Remove Logo
                </button>
              )}
            </div>

            {/* Brand Color */}
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Brand Color</h2>

              <div className="space-y-3">
                <input
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="w-full h-12 rounded-lg cursor-pointer"
                />
                <p className="text-xs text-slate-500 text-center">{brandColor}</p>

                <div
                  style={{ backgroundColor: brandColor }}
                  className="h-16 rounded-lg border border-zinc-700"
                />
              </div>
            </div>
          </div>

          {/* Right Panel: Templates */}
          <div className="lg:col-span-2">
            <div className="mb-6">
              <h2 className="mb-4 font-display font-semibold text-slate-900">Quote Templates</h2>
              <p className="text-sm text-slate-500 mb-4">Choose how your quotes look. You can customize further after selection.</p>
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
                  <div
                    className={`${template.preview} h-32 rounded-lg mb-3 border border-slate-200`}
                  />
                  <h3 className="font-semibold text-slate-900 text-left">{template.name}</h3>
                  <p className="text-xs text-slate-500 text-left mt-1">{template.description}</p>
                </button>
              ))}
            </div>

            {/* Preview Section */}
            <div className="mt-8 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
              <h3 className="mb-4 font-display font-semibold text-slate-900">Preview</h3>

              {/* Quote Preview */}
              <div className="bg-white rounded-lg p-8 text-black shadow-lg">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    {logo ? (
                      <img src={logo} alt="Logo" className="h-12 mb-2" />
                    ) : (
                      <div
                        className="h-12 w-12 rounded"
                        style={{ backgroundColor: brandColor }}
                      />
                    )}
                    <h4 className="font-bold text-lg mt-2">QUOTE</h4>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-semibold">Quote #12345</p>
                    <p className="text-gray-600">April 7, 2026</p>
                  </div>
                </div>

                <hr className="my-4" style={{ borderColor: brandColor }} />

                <div className="mb-6">
                  <h5 className="font-semibold text-gray-900 mb-2">Customer Details</h5>
                  <p className="text-sm text-gray-600">John Doe | john@example.com | (555) 123-4567</p>
                </div>

                <table className="w-full text-sm mb-6">
                  <thead>
                    <tr style={{ borderBottomColor: brandColor }} className="border-b-2">
                      <th className="text-left py-2 font-semibold">Description</th>
                      <th className="text-right py-2 font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">Professional HVAC Installation</td>
                      <td className="text-right">$2,450.00</td>
                    </tr>
                    <tr>
                      <td className="py-2 font-semibold">Total</td>
                      <td className="text-right font-semibold" style={{ color: brandColor }}>
                        $2,450.00
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div
                  className="p-4 rounded text-white text-center font-semibold"
                  style={{ backgroundColor: brandColor }}
                >
                  Valid for 30 days
                </div>
              </div>
            </div>

            {/* Save Button */}
            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={handleSave}
                disabled={isSaving || !tenantId}
                className="flex-1 px-6 py-3 bg-quotefly-primary text-white font-semibold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? "Saving..." : "Save Branding & Templates"}
              </button>
              {saveStatus === "saved" && (
                <span className="text-sm text-green-500 font-medium">✓ Saved</span>
              )}
              {saveStatus === "error" && (
                <span className="text-sm text-red-500 font-medium">Save failed</span>
              )}
            </div>
            {!tenantId && (
              <p className="mt-2 text-xs text-slate-400 text-center">Sign in to save your branding settings.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
