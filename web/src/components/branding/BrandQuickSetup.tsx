import type { ChangeEvent, RefObject } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AlignCenter, AlignLeft, AlignRight, CheckCircle2, Eye, ImageIcon, Upload } from "lucide-react";
import type { BrandingLogoPosition } from "../../lib/api";
import { QUOTE_TEMPLATE_OPTIONS, type StandardQuoteTemplateId } from "../quotes/quote-template";
import { Button } from "../ui";

function brandColorPresets(t: TFunction) {
  return [
    { label: t("branding.quick.colors.tradeBlue"), value: "#2A7FD8" },
    { label: t("branding.quick.colors.navy"), value: "#1E3A5F" },
    { label: t("branding.quick.colors.forest"), value: "#237A57" },
    { label: t("branding.quick.colors.orange"), value: "#D96528" },
    { label: t("branding.quick.colors.burgundy"), value: "#9F3341" },
    { label: t("branding.quick.colors.charcoal"), value: "#334155" },
  ] as const;
}

function logoPlacements(t: TFunction) {
  return [
    { value: "left", label: t("branding.placementValue.left"), icon: AlignLeft },
    { value: "center", label: t("branding.placementValue.center"), icon: AlignCenter },
    { value: "right", label: t("branding.placementValue.right"), icon: AlignRight },
  ] as const;
}

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
  const { t } = useTranslation();
  const colorPresets = brandColorPresets(t);
  const placements = logoPlacements(t);
  const templates = QUOTE_TEMPLATE_OPTIONS.map((template) => ({
    ...template,
    name: t(`branding.templates.${template.id}.name`),
    bestFor: t(`branding.templates.${template.id}.bestFor`),
    description: t(`branding.templates.${template.id}.description`),
  }));
  return (
    <section
      aria-labelledby="quick-brand-setup-title"
      className="overflow-hidden rounded-[28px] border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]"
    >
      <div className="border-b border-[var(--qf-border)] bg-[var(--qf-panel-subtle)] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--qf-link)]">{t("branding.quick.eyebrow")}</p>
            <h2 id="quick-brand-setup-title" className="mt-2 font-display text-2xl font-semibold text-[var(--qf-text)]">
              {t("branding.quick.title")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--qf-text-soft)]">
              {t("branding.quick.description")}
            </p>
          </div>
          <Button
            onClick={onSave}
            disabled={isSaving || !isDirty || isBusinessNameInvalid}
            loading={isSaving}
            className="min-h-11 shrink-0"
          >
            {isSaving ? t("branding.saving") : isDirty ? t("branding.quick.save") : t("branding.quick.saved")}
          </Button>
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-6">
        <div>
          <StepHeading number="1" title={t("branding.quick.templateTitle")} description={t("branding.quick.templateDescription")} />
          <div className="grid gap-3 md:grid-cols-3">
            {templates.map((template) => {
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
                  aria-label={t("branding.quick.useTemplate", { name: template.name })}
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
            <StepHeading number="2" title={t("branding.quick.logoTitle")} description={t("branding.quick.logoDescription")} />
            <input
              id="branding-logo-upload"
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={onLogoUpload}
              className="sr-only"
              tabIndex={-1}
              aria-label={t("branding.quick.chooseLogoAria")}
            />
            <div className="rounded-[22px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
              <div className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel)] p-4">
                {logo ? (
                  <img src={logo} alt={t("branding.quick.logoAlt")} className="max-h-16 max-w-full object-contain" />
                ) : (
                  <div className="text-center">
                    <ImageIcon size={24} className="mx-auto text-[var(--qf-text-muted)]" />
                    <p className="mt-2 text-sm font-medium text-[var(--qf-text-soft)]">{t("branding.quick.noLogo")}</p>
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="outline" icon={<Upload size={14} />} onClick={() => logoInputRef.current?.click()}>
                  {logo ? t("branding.logoSection.replace") : t("branding.logoSection.choose")}
                </Button>
                {logo ? (
                  <Button type="button" variant="ghost" onClick={onLogoRemove}>
                    {t("branding.quick.remove")}
                  </Button>
                ) : null}
              </div>
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{t("branding.quick.position")}</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {placements.map((option) => {
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
                        aria-label={t("branding.quick.placeLogo", { position: option.label })}
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
              title={t("branding.quick.colorTitle")}
              description={t("branding.quick.colorDescription")}
            />
            <div className="rounded-[22px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
              <div className="flex items-center gap-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3">
                <label
                  htmlFor="branding-quick-color"
                  className="relative h-16 w-20 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-[var(--qf-border)] shadow-[var(--qf-shadow-sm)]"
                  style={{ backgroundColor: brandColor }}
                >
                  <span className="sr-only">{t("branding.quick.customColor")}</span>
                  <input
                    id="branding-quick-color"
                    type="color"
                    value={brandColor}
                    onChange={(event) => onBrandColorChange(event.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--qf-text)]">{t("branding.colors.primary")}</p>
                  <p className="mt-1 font-mono text-sm uppercase text-[var(--qf-text-soft)]">{brandColor}</p>
                  <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("branding.quick.colorHelp")}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-6 gap-2">
                {colorPresets.map((color) => {
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
                      aria-label={t("branding.quick.useColor", { color: color.label, value: color.value })}
                      aria-pressed={active}
                      title={color.label}
                    />
                  );
                })}
              </div>
              <div className="mt-4 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[var(--qf-text)]">{t("branding.quick.automatic")}</p>
                    <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                      {componentColorOverrideCount > 0
                        ? t("branding.quick.overrides", { count: componentColorOverrideCount })
                        : t("branding.quick.primaryApplied")}
                    </p>
                  </div>
                  {componentColorOverrideCount > 0 ? (
                    <Button type="button" variant="outline" size="sm" onClick={onClearComponentColors}>
                      {t("branding.quick.usePrimary")}
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
              {isDirty ? t("branding.quick.readyToSave") : t("branding.quick.active")}
            </p>
            <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("branding.quick.advancedBelow")}</p>
          </div>
          <Button type="button" variant="outline" onClick={onViewPreview} icon={<Eye size={15} />}>
            {t("branding.quick.viewPreview")}
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
