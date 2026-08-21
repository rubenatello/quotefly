import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Lightbulb, Send, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../../i18n/i18n";
import { api, ApiError, type FeatureRequestInput } from "../../lib/api";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../../lib/contact";
import { Button, Input, Select, Textarea } from "../ui";

type FeatureRequestFormProps = {
  initialName?: string;
  initialEmail?: string;
  initialCompany?: string;
  source: FeatureRequestInput["source"];
  onSubmitted?: () => void;
};

export function FeatureRequestForm({
  initialName = "",
  initialEmail = "",
  initialCompany = "",
  source,
  onSubmitted,
}: FeatureRequestFormProps) {
  const { t } = useTranslation();
  const categoryOptions = [
    { value: "QUOTING", label: t("feedback.categories.quoting") },
    { value: "CUSTOMERS", label: t("feedback.categories.customers") },
    { value: "MOBILE", label: t("feedback.categories.mobile") },
    { value: "REPORTING", label: t("feedback.categories.reporting") },
    { value: "INTEGRATIONS", label: t("feedback.categories.integrations") },
    { value: "OTHER", label: t("feedback.categories.other") },
  ];
  const priorityOptions = [
    { value: "NICE_TO_HAVE", label: t("feedback.priorities.nice") },
    { value: "IMPORTANT", label: t("feedback.priorities.important") },
    { value: "BLOCKING", label: t("feedback.priorities.blocking") },
  ];
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [company, setCompany] = useState(initialCompany);
  const [category, setCategory] = useState<FeatureRequestInput["category"]>("QUOTING");
  const [priority, setPriority] = useState<FeatureRequestInput["priority"]>("IMPORTANT");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    setName((current) => current || initialName);
    setEmail((current) => current || initialEmail);
    setCompany((current) => current || initialCompany);
  }, [initialCompany, initialEmail, initialName]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await api.feedback.submitFeatureRequest({
        requestId: crypto.randomUUID(),
        name: name.trim(),
        email: email.trim(),
        company: company.trim() || undefined,
        category,
        priority,
        title: title.trim(),
        details: details.trim(),
        source,
        website,
      });
      setSuccessMessage(response.message);
      onSubmitted?.();
    } catch (submitError) {
      setError(
        submitError instanceof ApiError
          ? submitError.message
          : t("feedback.fallbackError", { email: SUPPORT_EMAIL }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function resetForAnotherIdea() {
    setCategory("QUOTING");
    setPriority("IMPORTANT");
    setTitle("");
    setDetails("");
    setWebsite("");
    setError(null);
    setSuccessMessage(null);
  }

  if (successMessage) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-6 text-center">
        <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <CheckCircle2 size={24} aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-lg font-bold text-slate-950">{t("feedback.received")}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{successMessage}</p>
        <Button className="mt-5" variant="outline" onClick={resetForAnotherIdea}>
          {t("feedback.another")}
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="rounded-xl border border-quotefly-blue/15 bg-quotefly-blue/[0.05] px-4 py-3">
        <div className="flex gap-3">
          <Lightbulb className="mt-0.5 shrink-0 text-quotefly-blue" size={18} aria-hidden="true" />
          <p className="text-sm leading-6 text-slate-700">
            {t("feedback.intro")}
          </p>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <a className="font-semibold underline" href={SUPPORT_MAILTO}>{t("feedback.emailSupport")}</a>
        </div>
      ) : null}

      <Select
        label={t("feedback.category")}
        value={category}
        onChange={(event) => setCategory(event.target.value as FeatureRequestInput["category"])}
        options={categoryOptions}
        required
      />

      <Input
        label={t("feedback.idea")}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t("feedback.ideaPlaceholder")}
        minLength={5}
        maxLength={120}
        required
      />

      <Textarea
        label={t("feedback.details")}
        value={details}
        onChange={(event) => setDetails(event.target.value)}
        placeholder={t("feedback.detailsPlaceholder")}
        minLength={10}
        maxLength={2500}
        rows={5}
        required
      />

      <Select
        label={t("feedback.priority")}
        value={priority}
        onChange={(event) => setPriority(event.target.value as FeatureRequestInput["priority"])}
        options={priorityOptions}
        required
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("feedback.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          minLength={2}
          maxLength={80}
          required
        />
        <Input
          label={t("feedback.email")}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          maxLength={254}
          required
        />
      </div>

      <Input
        label={t("feedback.company")}
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        autoComplete="organization"
        maxLength={120}
      />

      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="feature-request-website">{t("feedback.website")}</label>
        <input
          id="feature-request-website"
          tabIndex={-1}
          autoComplete="off"
          maxLength={200}
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        <p className="flex gap-2">
          <ShieldCheck className="mt-0.5 shrink-0 text-slate-500" size={15} aria-hidden="true" />
          <span>
            {t("feedback.privacyNotice")} <Link className="font-semibold text-quotefly-blue" to="/privacy">{t("feedback.privacyPolicy")}</Link>.
          </span>
        </p>
      </div>

      <Button type="submit" fullWidth size="lg" icon={<Send size={17} aria-hidden="true" />} loading={submitting}>
        {t("feedback.send")}
      </Button>
    </form>
  );
}
