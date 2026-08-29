import {
  IconBook2,
  IconBuildingBank,
  IconPlugConnected,
  IconShieldCheckFilled,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { QuickBooksSetupReadiness } from "../../lib/api";
import { Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader } from "../ui";

type QuickBooksSetupGuideProps = {
  open: boolean;
  onClose: () => void;
  environment: "sandbox" | "production";
  companyName?: string | null;
  operations: QuickBooksSetupReadiness["operations"];
  canConnect: boolean;
  onConnect: () => void;
};

const guideStepKeys = [
  "prepare",
  "authorize",
  "verify",
  "confirm",
  "test",
] as const;

export function QuickBooksSetupGuide({
  open,
  onClose,
  environment,
  companyName,
  operations,
  canConnect,
  onConnect,
}: QuickBooksSetupGuideProps) {
  const { t } = useTranslation();
  const title = t("admin.quickBooksSetup.guide.title");
  const paymentTestReady = operations.hostedPaymentsReady && operations.reconciliationReady;

  return (
    <Modal open={open} onClose={onClose} size="lg" ariaLabel={title}>
      <ModalHeader
        title={title}
        description={t("admin.quickBooksSetup.guide.description")}
        onClose={onClose}
      />
      <ModalBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
            <div className="flex items-center gap-2">
              <IconBuildingBank className="text-[var(--qf-primary)]" size={20} aria-hidden="true" />
              <p className="text-sm font-semibold text-[var(--qf-text)]">
                {t("admin.quickBooksSetup.guide.environmentLabel")}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={environment === "sandbox" ? "amber" : "slate"}>
                {environment === "sandbox"
                  ? t("admin.quickBooksSetup.sandbox")
                  : t("admin.quickBooksSetup.production")}
              </Badge>
              <span className="text-sm text-[var(--qf-text-soft)]">
                {environment === "sandbox"
                  ? t("admin.quickBooksSetup.guide.sandboxHint")
                  : t("admin.quickBooksSetup.guide.productionHint")}
              </span>
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
            <div className="flex items-center gap-2">
              <IconShieldCheckFilled className="text-[var(--qf-primary)]" size={20} aria-hidden="true" />
              <p className="text-sm font-semibold text-[var(--qf-text)]">
                {t("admin.quickBooksSetup.guide.companyLabel")}
              </p>
            </div>
            <p className="mt-2 break-words text-sm leading-6 text-[var(--qf-text-soft)]">
              {companyName || t("admin.quickBooksSetup.guide.noCompany")}
            </p>
          </div>
        </div>

        <section aria-labelledby="quickbooks-guide-steps-title">
          <div className="flex items-center gap-2">
            <IconBook2 className="text-[var(--qf-primary)]" size={20} aria-hidden="true" />
            <h3 id="quickbooks-guide-steps-title" className="font-semibold text-[var(--qf-text)]">
              {t("admin.quickBooksSetup.guide.stepsTitle")}
            </h3>
          </div>
          <ol className="mt-3 space-y-3">
            {guideStepKeys.map((step, index) => (
              <li
                key={step}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 sm:p-4"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--qf-info-surface)] text-sm font-bold text-[var(--qf-primary)]"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h4 className="font-semibold text-[var(--qf-text)]">
                    {step === "test" && !paymentTestReady
                      ? t("admin.quickBooksSetup.guide.steps.testPending.title")
                      : t(`admin.quickBooksSetup.guide.steps.${step}.title`)}
                  </h4>
                  <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">
                    {step === "test" && !paymentTestReady
                      ? t("admin.quickBooksSetup.guide.steps.testPending.description")
                      : t(`admin.quickBooksSetup.guide.steps.${step}.description`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <div className="rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] p-4">
          <p className="font-semibold text-[var(--qf-text)]">{t("admin.quickBooksSetup.guide.safeTestTitle")}</p>
          <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">
            {t("admin.quickBooksSetup.guide.safeTestDescription")}
          </p>
        </div>

        <p className="text-xs leading-5 text-[var(--qf-text-muted)]">
          {t("admin.quickBooksSetup.guide.trademark")}
        </p>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
        {canConnect ? (
          <Button
            icon={<IconPlugConnected size={18} />}
            onClick={() => {
              onClose();
              onConnect();
            }}
          >
            {t("admin.quickBooksSetup.connect")}
          </Button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}
