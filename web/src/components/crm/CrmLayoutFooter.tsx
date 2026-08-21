import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function CrmLayoutFooter() {
  const { t } = useTranslation();
  return (
    <footer className="border-t border-slate-200/80 bg-white/80 px-6 py-4 text-xs text-slate-500 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-[1840px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{t("feedback.footerWorkspace")}</span>
        <nav aria-label={t("feedback.footerAria")} className="flex flex-wrap gap-x-4 gap-y-2">
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/privacy">{t("feedback.privacy")}</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/terms">{t("feedback.terms")}</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/cookies">{t("feedback.cookies")}</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/support">{t("feedback.support")}</Link>
        </nav>
      </div>
    </footer>
  );
}
