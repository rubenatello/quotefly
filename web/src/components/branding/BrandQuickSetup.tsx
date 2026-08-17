import type { ChangeEvent, RefObject } from "react";
import { AlignCenter, AlignLeft, AlignRight, CheckCircle2, Eye, ImageIcon, Upload } from "lucide-react";
import type { BrandingLogoPosition } from "../../lib/api";
import { QUOTE_TEMPLATE_OPTIONS, type StandardQuoteTemplateId } from "../quotes/quote-template";
import { Button } from "../ui";

const BRAND_COLOR_PRESETS = [
  { label: "Trade blue", value: "#2A7FD8" },
  { label: "Navy", value: "#1E3A5F" },
  { label: "Forest", value: "#237A57" },
  { label: "Safety orange", value: "#D96528" },
  { label: "Burgundy", value: "#9F3341" },
  { label: "Charcoal", value: "#334155" },
] as const;

const LOGO_PLACEMENTS = [
  { value: "left", label: "Left", icon: AlignLeft },
  { value: "center", label: "Center", icon: AlignCenter },
  { value: "right", label: "Right", icon: AlignRight },
] as const;

interface BrandQuickSetupProps {
  brandColor: string;
  componentColorOverrideCount: number;
  isBusinessNameInvalid: boolean;
  isDirty: boolean;
  isSaving: boolean;
  logo: string | null;
  logoInputRef: RefObject<HTMLInputElement | null>;
  logoPosition: BrandingLogoPosition;
  selectedTemplate: StandardQuoteTemplateId;
  onBrandColorChange: (value: string) => void;
  onClearComponentColors: () => void;
  onLogoPositionChange: (position: BrandingLogoPosition) => void;
  onLogoRemove: () => void;
  onLogoUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
  onTemplateChange: (templateId: StandardQuoteTemplateId) => void;
  onViewPreview: () => void;
}

export function BrandQuickSetup({
  brandColor,
  componentColorOverrideCount,
  isBusinessNameInvalid,
  isDirty,
  isSaving,
  logo,
  logoInputRef,
  logoPosition,
  selectedTemplate,
  onBrandColorChange,
  onClearComponentColors,
  onLogoPositionChange,
  onLogoRemove,
  onLogoUpload,
  onSave,
  onTemplateChange,
  onViewPreview,
}: BrandQuickSetupProps) {
  return (
    <section
      aria-labelledby="quick-brand-setup-title"
      className="overflow-hidden rounded-[28px] border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]"
    >
      <div className="border-b border-[var(--qf-border)] bg-[var(--qf-panel-subtle)] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--qf-link)]">Start here</p>
            <h2 id="quick-brand-setup-title" className="mt-2 font-display text-2xl font-semibold text-[var(--qf-text)]">
              Build your quote look in three steps
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--qf-text-soft)]">
              Pick a layout, add your logo, and choose one brand color. QuoteFly handles the rest automatically.
            </p>
          </div>
          <Button
            onClick={onSave}
            disabled={isSaving || !isDirty || isBusinessNameInvalid}
            loading={isSaving}
            className="min-h-11 shrink-0"
          >
            {isSaving ? "Saving..." : isDirty ? "Save Brand" : "Brand Saved"}
          </Button>
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-6">
        <div>
          <StepHeading number="1" title="Choose a quote preset" description="All three are customer-ready and work on screen and PDF." />
          <div className="grid gap-3 md:grid-cols-3">
            {QUOTE_TEMPLATE_OPTIONS.map((template) => {
              const active = selectedTemplate === template.id;

              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onTemplateChange(template.id)}
                  className={`min-h-[170px] rounded-[22px] border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-quotefly-blue focus-visible:ring-offset-2 ${
                    active
                      ? "border-quotefly-blue bg-[var(--qf-selected)] shadow-[var(--qf-shadow-md)]"
                      : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
                  }`}
                  aria-pressed={active}
                  aria-label={`Use ${template.name} quote preset`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold text-[var(--qf-text)]">{template.name}</p>
                      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[var(--qf-text-soft)]">{template.bestFor}</p>
                    </div>
                    <span
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                        active
                          ? "border-quotefly-blue bg-quotefly-blue text-white"
                          : "border-[var(--qf-border-strong)] bg-[var(--qf-panel)] text-transparent"
                      }`}
                      aria-hidden="true"
                    >
                      <CheckCircle2 size={16} />
                    </span>
                  </div>
                  <PresetPreview headerStyle={template.headerStyle} brandColor={brandColor} previewClass={template.preview} />
                  <p className="mt-3 text-sm leading-5 text-[var(--qf-text-soft)]">{template.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-5 border-t border-[var(--qf-border)] pt-6 lg:grid-cols-2">
          <div>
            <StepHeading number="2" title="Add your logo" description="PNG or JPG. We resize it for every quote." />
            <input
              id="branding-logo-upload"
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={onLogoUpload}
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose a PNG or JPG business logo"
            />
            <div className="rounded-[22px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
              <div className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel)] p-4">
                {logo ? (
                  <img src={logo} alt="Your business logo" className="max-h-16 max-w-full object-contain" />
                ) : (
                  <div className="text-center">
                    <ImageIcon size={24} className="mx-auto text-[var(--qf-text-muted)]" />
                    <p className="mt-2 text-sm font-medium text-[var(--qf-text-soft)]">No logo yet</p>
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="outline" icon={<Upload size={14} />} onClick={() => logoInputRef.current?.click()}>
                  {logo ? "Replace Logo" : "Choose Logo"}
                </Button>
                {logo ? (
                  <Button type="button" variant="ghost" onClick={onLogoRemove}>
                    Remove
                  </Button>
                ) : null}
              </div>
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">Position</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {LOGO_PLACEMENTS.map((option) => {
                    const Icon = option.icon;
                    const active = logoPosition === option.value;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => onLogoPositionChange(option.value)}
                        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2 text-xs font-semibold transition ${
                          active
                            ? "border-quotefly-blue bg-[var(--qf-selected)] text-[var(--qf-link)]"
                            : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
                        }`}
                        aria-pressed={active}
                        aria-label={`Place logo ${option.value}`}
                      >
                        <Icon size={15} />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div>
            <StepHeading
              number="3"
              title="Choose your brand color"
              description="One color automatically styles headers, sections, and totals."
            />
            <div className="rounded-[22px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
              <div className="flex items-center gap-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3">
                <label
                  htmlFor="branding-quick-color"
                  className="relative h-16 w-20 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-[var(--qf-border)] shadow-[var(--qf-shadow-sm)]"
                  style={{ backgroundColor: brandColor }}
                >
                  <span className="sr-only">Choose a custom brand color</span>
                  <input
                    id="branding-quick-color"
                    type="color"
                    value={brandColor}
                    onChange={(event) => onBrandColorChange(event.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--qf-text)]">Primary color</p>
                  <p className="mt-1 font-mono text-sm uppercase text-[var(--qf-text-soft)]">{brandColor}</p>
                  <p className="mt-1 text-xs text-[var(--qf-text-muted)]">Tap the color block for a custom color.</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-6 gap-2">
                {BRAND_COLOR_PRESETS.map((color) => {
                  const active = brandColor.toLowerCase() === color.value.toLowerCase();

                  return (
                    <button
                      key={color.value}
                      type="button"
                      onClick={() => onBrandColorChange(color.value)}
                      className={`h-11 rounded-xl border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-quotefly-blue focus-visible:ring-offset-2 ${
                        active ? "border-[var(--qf-text)] ring-2 ring-[var(--qf-panel)] ring-inset" : "border-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]"
                      }`}
                      style={{ backgroundColor: color.value }}
                      aria-label={`Use ${color.label} (${color.value})`}
                      aria-pressed={active}
                      title={color.label}
                    />
                  );
                })}
              </div>
              <div className="mt-4 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[var(--qf-text)]">Automatic color assignment</p>
                    <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                      {componentColorOverrideCount > 0
                        ? `${componentColorOverrideCount} advanced color ${componentColorOverrideCount === 1 ? "override is" : "overrides are"} active.`
                        : "Your primary color is applied throughout the quote."}
                    </p>
                  </div>
                  {componentColorOverrideCount > 0 ? (
                    <Button type="button" variant="outline" size="sm" onClick={onClearComponentColors}>
                      Use Primary Everywhere
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--qf-text)]">
              {isDirty ? "Your brand preview is updated and ready to save." : "Your saved brand is active on quotes."}
            </p>
            <p className="mt-1 text-xs text-[var(--qf-text-muted)]">Business details and advanced color controls are available below when you need them.</p>
          </div>
          <Button type="button" variant="outline" onClick={onViewPreview} icon={<Eye size={15} />}>
            View Full Preview
          </Button>
        </div>
      </div>
    </section>
  );
}

function StepHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--qf-text)] text-sm font-semibold text-[var(--qf-panel)]">
        {number}
      </span>
      <div>
        <h3 className="text-base font-semibold text-[var(--qf-text)]">{title}</h3>
        <p className="text-sm text-[var(--qf-text-muted)]">{description}</p>
      </div>
    </div>
  );
}

function PresetPreview({
  brandColor,
  headerStyle,
  previewClass,
}: {
  brandColor: string;
  headerStyle: "bar" | "card" | "minimal";
  previewClass: string;
}) {
  return (
    <div className={`mt-4 rounded-2xl border border-slate-200 p-3 ${previewClass}`} aria-hidden="true">
      {headerStyle === "bar" ? (
        <>
          <div className="h-2 rounded-full" style={{ backgroundColor: brandColor }} />
          <div className="mt-3 h-10 rounded-xl border border-slate-200 bg-white" />
        </>
      ) : headerStyle === "card" ? (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-2">
            <div className="h-8 rounded-lg" style={{ backgroundColor: `${brandColor}18` }} />
          </div>
          <div className="mt-2 h-8 rounded-xl border border-slate-200 bg-white" />
        </>
      ) : (
        <>
          <div className="h-2 w-1/2 rounded-full bg-slate-700" />
          <div className="mt-3 h-10 border-t border-slate-300 bg-white" />
        </>
      )}
    </div>
  );
}
