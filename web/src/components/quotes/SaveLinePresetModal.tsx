import { BookmarkPlus, FileText, ListPlus } from "lucide-react";
import type { EditableQuoteLine } from "../../lib/quote-lines";
import { Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader } from "../ui";

export function SaveLinePresetModal({
  open,
  line,
  saving,
  onClose,
  onSaveFull,
  onSaveNameOnly,
}: {
  open: boolean;
  line: EditableQuoteLine | null;
  saving: boolean;
  onClose: () => void;
  onSaveFull: () => void;
  onSaveNameOnly: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md" ariaLabel="Save work name for future jobs">
      <ModalHeader
        title="Save this work name for future jobs?"
        description="QuoteFly can save this line to your tenant's common work library so the crew can load it faster next time."
        onClose={onClose}
      />
      <ModalBody>
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <Badge tone="blue" icon={<ListPlus size={12} />}>
                Reusable job
              </Badge>
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Preview</span>
            </div>
            <p className="mt-3 text-base font-semibold text-slate-900">{line?.title || "Untitled line"}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
              {line?.details?.trim() ? line.details : "No description on this line yet."}
            </p>
          </div>

          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600">
            QuoteFly will save the current line under this trade using the line's current quantity, cost, and price defaults.
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="justify-stretch sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          No, do not save
        </Button>
        <Button type="button" variant="outline" icon={<FileText size={14} />} onClick={onSaveNameOnly} loading={saving}>
          Save job name only
        </Button>
        <Button type="button" icon={<BookmarkPlus size={14} />} onClick={onSaveFull} loading={saving}>
          Save name + description
        </Button>
      </ModalFooter>
    </Modal>
  );
}

