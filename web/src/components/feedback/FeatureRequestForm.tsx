import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Lightbulb, Send, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
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

const CATEGORY_OPTIONS = [
  { value: "QUOTING", label: "Building and sending quotes" },
  { value: "CUSTOMERS", label: "Customers and follow-up" },
  { value: "MOBILE", label: "Mobile and on-the-go workflow" },
  { value: "REPORTING", label: "Reporting and analytics" },
  { value: "INTEGRATIONS", label: "Integrations" },
  { value: "OTHER", label: "Something else" },
];

const PRIORITY_OPTIONS = [
  { value: "NICE_TO_HAVE", label: "Nice to have" },
  { value: "IMPORTANT", label: "Would save me real time" },
  { value: "BLOCKING", label: "This blocks work today" },
];

export function FeatureRequestForm({
  initialName = "",
  initialEmail = "",
  initialCompany = "",
  source,
  onSubmitted,
}: FeatureRequestFormProps) {
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
          : `Your idea could not be sent right now. Please email ${SUPPORT_EMAIL}.`,
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
        <h3 className="mt-4 text-lg font-bold text-slate-950">Idea received</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{successMessage}</p>
        <Button className="mt-5" variant="outline" onClick={resetForAnotherIdea}>
          Share another idea
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
            Tell us what would save you time on the job. Plain language is perfect.
          </p>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <a className="font-semibold underline" href={SUPPORT_MAILTO}>Email support</a>
        </div>
      ) : null}

      <Select
        label="What part of QuoteFly?"
        value={category}
        onChange={(event) => setCategory(event.target.value as FeatureRequestInput["category"])}
        options={CATEGORY_OPTIONS}
        required
      />

      <Input
        label="Your feature idea"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Example: Let me copy a quote into a new job"
        minLength={5}
        maxLength={120}
        required
      />

      <Textarea
        label="How would this help your workday?"
        value={details}
        onChange={(event) => setDetails(event.target.value)}
        placeholder="What takes too long today? What would the easier version look like?"
        minLength={10}
        maxLength={2500}
        rows={5}
        required
      />

      <Select
        label="How important is it?"
        value={priority}
        onChange={(event) => setPriority(event.target.value as FeatureRequestInput["priority"])}
        options={PRIORITY_OPTIONS}
        required
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          minLength={2}
          maxLength={80}
          required
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          maxLength={254}
          required
        />
      </div>

      <Input
        label="Company (optional)"
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        autoComplete="organization"
        maxLength={120}
      />

      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="feature-request-website">Website</label>
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
            Please do not include customer names, phone numbers, addresses, or quote details. By submitting, you agree
            QuoteFly may contact you about this idea. See our <Link className="font-semibold text-quotefly-blue" to="/privacy">Privacy Policy</Link>.
          </span>
        </p>
      </div>

      <Button type="submit" fullWidth size="lg" icon={<Send size={17} aria-hidden="true" />} loading={submitting}>
        Send feature idea
      </Button>
    </form>
  );
}
