import { BookmarkPlus, FileText, ListPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} size="md" ariaLabel={t("quoteComponents.savePreset.ariaLabel")}>
      <ModalHeader
        title={t("quoteComponents.savePreset.title")}
        description={t("quoteComponents.savePreset.description")}
        onClose={onClose}
      />
      <ModalBody>
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
            <div className="flex items-center gap-2">
              <Badge tone="blue" icon={<ListPlus size={12} />}>
                {t("quoteComponents.savePreset.reusable")}
              </Badge>
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteComponents.savePreset.preview")}</span>
            </div>
            <p className="mt-3 text-base font-semibold text-[var(--qf-text)]">{line?.title || t("quoteComponents.savePreset.untitled")}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--qf-text-soft)]">
              {line?.details?.trim() ? line.details : t("quoteComponents.savePreset.noDescription")}
            </p>
          </div>

          <div className="rounded-2xl border border-dashed border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 text-sm text-[var(--qf-text-soft)]">
            {t("quoteComponents.savePreset.help")}
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="justify-stretch sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {t("quoteComponents.savePreset.no")}
        </Button>
        <Button type="button" variant="outline" icon={<FileText size={14} />} onClick={onSaveNameOnly} loading={saving}>
          {t("quoteComponents.savePreset.nameOnly")}
        </Button>
        <Button type="button" icon={<BookmarkPlus size={14} />} onClick={onSaveFull} loading={saving}>
          {t("quoteComponents.savePreset.full")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

