import { useMemo, useState } from "react";
import { Search } from "lucide-react";
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
}) {
  const [query, setQuery] = useState("");

  const filteredPresets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return presets;
    return presets.filter((preset) =>
      `${preset.name} ${preset.description ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [presets, query]);

  const selectedPreset = filteredPresets.find((preset) => preset.id === selectedPresetId)
    ?? presets.find((preset) => preset.id === selectedPresetId)
    ?? null;

  return (
    <Modal open={open} onClose={onClose} size="lg" ariaLabel="Saved jobs">
      <ModalHeader
        title="Saved jobs"
        description="Pick a standard or saved job, set quantity, then load it into the quote."
        onClose={onClose}
      />
      <ModalBody className="space-y-4 bg-slate-50">
        <Input
          label="Search jobs"
          icon={<Search size={14} />}
          placeholder="Search saved jobs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="grid gap-2 sm:grid-cols-2">
          {filteredPresets.length ? (
            filteredPresets.map((preset) => {
              const active = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onSelectPreset(preset.id)}
                  className={`rounded-2xl border px-4 py-3 text-left transition ${
                    active
                      ? "border-quotefly-blue/20 bg-white shadow-[0_8px_18px_rgba(15,23,42,0.06)]"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold ${active ? "text-quotefly-blue" : "text-slate-900"}`}>
                        {preset.name}
                      </p>
                      {preset.description ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{preset.description}</p>
                      ) : null}
                    </div>
                    {preset.catalogKey ? <Badge tone="blue">Standard</Badge> : <Badge tone="slate">Saved</Badge>}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                    <span>{money(preset.unitPrice)} / {formatPresetUnitLabel(preset.unitType)}</span>
                    <span>Cost {money(preset.unitCost)}</span>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500 sm:col-span-2">
              No saved jobs match this search.
            </div>
          )}
        </div>

        {selectedPreset ? (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Selected job</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{selectedPreset.name}</p>
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
        <Button variant="outline" onClick={onClose}>
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
