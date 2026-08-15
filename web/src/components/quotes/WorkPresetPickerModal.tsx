import { useMemo, useState } from "react";
import { PackageSearch, Search } from "lucide-react";
import { money } from "../dashboard/DashboardContext";
import { Badge, Button, Input, Modal, ModalBody, ModalFooter, ModalHeader } from "../ui";
import type { WorkPreset } from "../../lib/api";

function formatPresetUnitLabel(unitType: WorkPreset["unitType"]): string {
  if (unitType === "SQ_FT") return "SQ FT";
  if (unitType === "HOUR") return "Hours";
  if (unitType === "EACH") return "Units";
  return "Qty";
}

export function WorkPresetPickerModal({
  open,
  onClose,
  presets,
  selectedPresetId,
  onSelectPreset,
  quantity,
  onQuantityChange,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
  onManageProducts,
  canViewInternalCosts = true,
}: {
  open: boolean;
  onClose: () => void;
  presets: WorkPreset[];
  selectedPresetId: string;
  onSelectPreset: (presetId: string) => void;
  quantity: string;
  onQuantityChange: (value: string) => void;
  primaryActionLabel: string;
  onPrimaryAction: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  onManageProducts?: () => void;
  canViewInternalCosts?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "STANDARD" | "CUSTOM">("ALL");

  const filteredPresets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return presets.filter((preset) => {
      if (sourceFilter === "STANDARD" && !preset.catalogKey) return false;
      if (sourceFilter === "CUSTOM" && preset.catalogKey) return false;
      if (!normalized) return true;
      return `${preset.name} ${preset.description ?? ""}`.toLowerCase().includes(normalized);
    });
  }, [presets, query, sourceFilter]);

  const selectedPreset = filteredPresets.find((preset) => preset.id === selectedPresetId) ?? null;

  function closePicker() {
    setQuery("");
    setSourceFilter("ALL");
    onClose();
  }

  return (
    <Modal open={open} onClose={closePicker} size="lg" ariaLabel="Products and services">
      <ModalHeader
        title="Products & services"
        description="Choose a standard or custom catalog item, set quantity, then add it to the quote."
        onClose={closePicker}
      />
      <ModalBody className="space-y-4 bg-[var(--qf-panel-muted)]">
        <Input
          label="Search products"
          icon={<Search size={14} />}
          placeholder="Search products and descriptions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-1" aria-label="Product source filter">
            {([
              { value: "ALL", label: "All" },
              { value: "STANDARD", label: "Standard" },
              { value: "CUSTOM", label: "Custom" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={sourceFilter === option.value}
                onClick={() => setSourceFilter(option.value)}
                className={`min-h-[44px] rounded-lg px-3 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[36px] ${
                  sourceFilter === option.value
                    ? "bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] shadow-[var(--qf-shadow-sm)]"
                    : "text-[var(--qf-text-soft)] hover:bg-[var(--qf-interactive-hover)]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {onManageProducts ? (
            <Button variant="ghost" size="sm" icon={<PackageSearch size={14} />} onClick={onManageProducts}>
              Manage catalog
            </Button>
          ) : null}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {filteredPresets.length ? (
            filteredPresets.map((preset) => {
              const active = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onSelectPreset(preset.id)}
                  className={`min-h-[44px] rounded-2xl border px-4 py-3 text-left transition sm:min-h-[40px] ${
                    active
                      ? "border-[var(--qf-info-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)] ring-2 ring-[var(--qf-focus-ring)]"
                      : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold ${active ? "text-[var(--qf-link)]" : "text-[var(--qf-text)]"}`}>
                        {preset.name}
                      </p>
                      {preset.description ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--qf-text-muted)]">{preset.description}</p>
                      ) : null}
                    </div>
                    {preset.catalogKey ? <Badge tone="blue">Standard</Badge> : <Badge tone="slate">Saved</Badge>}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--qf-text-muted)]">
                    <span>{money(preset.unitPrice)} / {formatPresetUnitLabel(preset.unitType)}</span>
                    {canViewInternalCosts ? <span>Cost {money(preset.unitCost ?? 0)}</span> : null}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel)] px-4 py-6 text-sm text-[var(--qf-text-muted)] sm:col-span-2">
              No products match this search and filter.
            </div>
          )}
        </div>

        {selectedPreset ? (
          <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Selected product</p>
                <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{selectedPreset.name}</p>
              </div>
              <div className="w-24">
                <Input
                  label={formatPresetUnitLabel(selectedPreset.unitType)}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={quantity}
                  onChange={(event) => onQuantityChange(event.target.value)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={closePicker}>
          Close
        </Button>
        {secondaryActionLabel && onSecondaryAction ? (
          <Button variant="outline" onClick={onSecondaryAction} disabled={!selectedPreset}>
            {secondaryActionLabel}
          </Button>
        ) : null}
        <Button onClick={onPrimaryAction} disabled={!selectedPreset}>
          {primaryActionLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
