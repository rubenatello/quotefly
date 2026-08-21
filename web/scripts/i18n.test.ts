import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TFunction } from "i18next";
import { enUS } from "../src/i18n/locales/en-US";
import { esUS } from "../src/i18n/locales/es-US";
import { ApiError } from "../src/lib/api";
import { localizedApiError } from "../src/lib/localized-api-error";
import {
  aiUsageWarningCopy,
  formatAiUsageAvailability,
  formatAiRenewalDate,
} from "../src/lib/ai-credits";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveInitialLocale,
} from "../src/i18n/supported-locales";

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return entries;

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      entries.set(path, child);
      continue;
    }
    for (const [nestedKey, nestedValue] of flatten(child, path)) entries.set(nestedKey, nestedValue);
  }
  return entries;
}

function interpolationTokens(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g), (match) => match[1]).sort();
}

function dictionaryT(dictionary: unknown): TFunction {
  return ((key: string, options?: Record<string, unknown>) => {
    let value: unknown = dictionary;
    for (const segment of key.split(".")) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined;
    }
    assert.equal(typeof value, "string", `Translation missing for ${key}`);
    return (value as string).replace(/{{\s*([^},\s]+)[^}]*}}/g, (_match, token: string) => String(options?.[token] ?? ""));
  }) as TFunction;
}

test("English and Spanish dictionaries have exact key and interpolation parity", () => {
  const english = flatten(enUS);
  const spanish = flatten(esUS);
  assert.deepEqual([...spanish.keys()].sort(), [...english.keys()].sort());

  for (const [key, value] of english) {
    const translated = spanish.get(key);
    assert.equal(typeof translated, "string", `Spanish translation missing for ${key}`);
    assert.notEqual(translated?.trim(), "", `Spanish translation is blank for ${key}`);
    assert.deepEqual(
      interpolationTokens(translated ?? ""),
      interpolationTokens(value),
      `Interpolation token mismatch for ${key}`,
    );
    assert.doesNotMatch(value, /\uFFFD|Ã.|Â.|â€|â€™|â€œ|â€/, `English translation contains mojibake for ${key}`);
    assert.doesNotMatch(translated ?? "", /\uFFFD|Ã.|Â.|â€|â€™|â€œ|â€/, `Spanish translation contains mojibake for ${key}`);
  }
});

test("stored locale wins, then browser locale, then English fallback", () => {
  assert.equal(resolveInitialLocale({ storedLocale: "es-US", navigatorLanguages: ["en-US"] }), "es-US");
  assert.equal(resolveInitialLocale({ navigatorLanguages: ["es-MX", "en-US"] }), "es-US");
  assert.equal(resolveInitialLocale({ navigatorLanguages: ["fr-FR"] }), DEFAULT_LOCALE);
});

test("locale normalization only returns supported application locales", () => {
  assert.equal(normalizeLocale("es"), "es-US");
  assert.equal(normalizeLocale("es-419"), "es-US");
  assert.equal(normalizeLocale("en-GB"), "en-US");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(normalizeLocale(undefined), null);
});

test("locale initializes before React paint and account save failures roll back", () => {
  const i18nSource = readFileSync(new URL("../src/i18n/i18n.ts", import.meta.url), "utf8");
  const selectorSource = readFileSync(new URL("../src/components/settings/LanguageSelector.tsx", import.meta.url), "utf8");
  const adminSource = readFileSync(new URL("../src/pages/AdminPage.tsx", import.meta.url), "utf8");

  assert.match(i18nSource, /lng:\s*initialLocale/);
  assert.match(i18nSource, /localStorage\.getItem\(LOCALE_STORAGE_KEY\)/);
  assert.match(selectorSource, /await setLocale\(previousLocale\)/);
  assert.match(adminSource, /notify\.error\(t\("language\.saveError"\)\);\s*throw error;/s);
});

test("workspace dates and task labels use tenant time and localized enum copy", () => {
  const homeSource = readFileSync(new URL("../src/pages/WorkspaceHomePage.tsx", import.meta.url), "utf8");
  const activitySource = readFileSync(new URL("../src/views/PipelineView.tsx", import.meta.url), "utf8");

  assert.match(homeSource, /greetingForNow\(t, session\?\.timezone \?\? "UTC"\)/);
  assert.match(homeSource, /formatTenantDateTime\(task\.dueAtUtc, activitySummary\.timezone, locale\)/);
  assert.match(homeSource, /activity\.tasks\.priorityValue/);
  assert.doesNotMatch(homeSource, />\s*\{task\.priority\.toLowerCase\(\)\}/);
  assert.match(activitySource, /compactDateTime\([^)]*locale, timeZone\)/);
  assert.match(activitySource, /formatDateTime\(lead\.createdAt, locale, timeZone\)/);
});

test("authentication and billing copy remains complete in neutral U.S. Spanish", () => {
  assert.equal(esUS.auth.trades.roofing, "Techos");
  assert.equal(esUS.auth.reset.updatePassword, "Actualizar contraseña");
  assert.equal(esUS.billing.updateBilling, "Actualizar pago");
  assert.match(esUS.billing.trial.ownerChoose, /propietario/);
});

test("API failures use stable localized mappings and never render backend or provider prose", () => {
  const spanish = dictionaryT(esUS);

  const duplicateSignup = localizedApiError(
    new ApiError("An account with this email already exists.", 409, {}),
    spanish,
    { fallbackKey: "auth.genericError", statusKeys: { 409: "apiErrors.accountExists" } },
  );
  assert.equal(duplicateSignup, esUS.apiErrors.accountExists);

  const duplicateCustomer = localizedApiError(
    new ApiError("backend customer prose", 409, { code: "DUPLICATE_CANDIDATE" }),
    spanish,
    { fallbackKey: "quoteFeedback.customer.createError" },
  );
  assert.equal(duplicateCustomer, esUS.apiErrors.customerDuplicate);

  const duplicateProduct = localizedApiError(
    new ApiError("A product with this name already exists for the selected trade.", 409, { code: "PRODUCT_NAME_CONFLICT" }),
    spanish,
    { fallbackKey: "products.saveError" },
  );
  assert.equal(duplicateProduct, esUS.apiErrors.productNameConflict);

  const existingSubscription = localizedApiError(
    new ApiError("A subscription already exists. Use billing management to change it.", 409, {}),
    spanish,
    { fallbackKey: "billing.checkoutFailed", statusKeys: { 409: "apiErrors.subscriptionExists" } },
  );
  assert.equal(existingSubscription, esUS.apiErrors.subscriptionExists);

  const providerFailure = localizedApiError(
    new ApiError("Stripe request failed: request_id=secret-provider-detail", 503, {}),
    spanish,
    { fallbackKey: "billing.checkoutFailed" },
  );
  assert.equal(providerFailure, esUS.apiErrors.serviceUnavailable);
  assert.doesNotMatch(providerFailure, /Stripe|request_id|secret-provider-detail/i);

  const rawEnglishSentinel = "Raw English backend task failure must never be shown";
  const staleTask = localizedApiError(
    new ApiError(rawEnglishSentinel, 409, { code: "ACTIVITY_STALE_VERSION" }),
    spanish,
    { fallbackKey: "activity.tasks.saveError" },
  );
  assert.equal(staleTask, esUS.apiErrors.activityStale);
  assert.doesNotMatch(staleTask, /Raw English backend task failure/i);

  const invalidReset = localizedApiError(
    new ApiError(rawEnglishSentinel, 400, {}),
    spanish,
    { fallbackKey: "auth.reset.failed", statusKeys: { 400: "auth.reset.invalidOrExpired" } },
  );
  assert.equal(invalidReset, esUS.auth.reset.invalidOrExpired);
  assert.doesNotMatch(invalidReset, /Raw English backend task failure/i);
});

test("authenticated administration and support surfaces have complete Spanish copy", () => {
  assert.equal(esUS.admin.team.addUser, "Agregar usuario");
  assert.equal(esUS.admin.status.pastDue, "Pago vencido");
  assert.equal(esUS.myInfo.tenantScoped, "Limitado a este espacio");
  assert.equal(esUS.commands.items.newQuote.label, "Nueva cotización");
  assert.equal(esUS.feedback.dismissNotification, "Descartar notificación");
  assert.match(esUS.feedback.privacyNotice, /detalles de cotizaciones/);
  assert.match(esUS.admin.team.removeDescription, /{{name}}/);
  assert.match(esUS.language.saveError, /restauró el idioma anterior/);
  assert.equal(esUS.activity.tasks.priorityValue.urgent, "Urgente");
  assert.equal(esUS.customers.activity.event.customerAdded, "Cliente agregado");
  assert.match(esUS.customers.activity.loadingDescription, /notas recientes/);
});

test("authenticated core failure paths never render raw API error messages", () => {
  const sources = [
    "../src/components/activity/ActivityTaskPanel.tsx",
    "../src/components/customers/QuickCustomerModal.tsx",
    "../src/components/dashboard/QuickLookupCard.tsx",
    "../src/pages/ResetPasswordPage.tsx",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  for (const source of sources) {
    assert.match(source, /localizedApiError\(/);
    assert.doesNotMatch(
      source,
      /\b(?:err|error|loadError|lookupError|saveError|reopenError)\.message\b/,
      "Authenticated UI must not render server-authored Error.message copy.",
    );
  }

  assert.equal(esUS.activity.tasks.completedNotice, "Tarea terminada");
  assert.equal(esUS.activity.tasks.undo, "Deshacer");
  assert.equal(esUS.activity.tasks.removedNotice, "Tarea quitada");
});

test("shared UI defaults and customer errors stay behind the active locale", () => {
  const sharedUiSource = readFileSync(new URL("../src/components/ui/index.tsx", import.meta.url), "utf8");
  const customerSource = readFileSync(new URL("../src/pages/CustomersPage.tsx", import.meta.url), "utf8");

  for (const key of [
    "common.loading",
    "common.dismissAlert",
    "common.dialog",
    "common.closeModal",
    "common.confirm",
    "common.cancel",
    "common.progress",
    "common.actionsLabel",
    "common.pagination.label",
    "common.pagination.rowsPerPage",
    "common.pagination.rowsPerPageFor",
    "common.pagination.rangeOf",
    "common.pagination.previousPageOf",
    "common.pagination.nextPageOf",
    "common.previous",
    "common.pageOf",
    "common.next",
  ]) {
    assert.match(sharedUiSource, new RegExp(`t\\("${key.replaceAll(".", "\\.")}"`), `Shared UI must use ${key}.`);
  }

  for (const hardcodedDefault of [
    'title = "Loading"',
    'confirmLabel = "Confirm"',
    'cancelLabel = "Cancel"',
    'aria-label="Dismiss alert"',
    'label="Close modal"',
    'aria-label={label ?? "Progress"}',
    'label="Rows per page"',
  ]) {
    assert.equal(sharedUiSource.includes(hardcodedDefault), false, `Shared UI rendered hardcoded copy: ${hardcodedDefault}`);
  }

  assert.equal(
    customerSource.includes('{error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}'),
    true,
    "CustomersPage must render the already-sanitized localized error value.",
  );
  assert.equal(
    customerSource.includes('{t("customers.errors.action")}</Alert> : null}'),
    false,
    "CustomersPage must preserve the already-sanitized localized error value.",
  );
  assert.equal(esUS.common.cancel, "Cancelar");
  assert.equal(esUS.common.pagination.rowsPerPage, "Filas por página");
  assert.equal(esUS.common.closeModal, "Cerrar modal");
});

test("AI budget warnings and dates use the requested locale", () => {
  const renewalDate = "2026-08-31T12:00:00.000Z";
  const spanishWarning = aiUsageWarningCopy(100, renewalDate, "es-US");
  assert.equal(spanishWarning.title, "Se alcanzó el límite mensual de IA");
  assert.match(spanishWarning.description, /Kody y las herramientas de IA están en pausa/);
  assert.match(spanishWarning.description, /Se restablece/);

  const spanishAvailability = formatAiUsageAvailability({
    usedUsd: 0.75,
    limitUsd: 1.25,
    renewsAtUtc: renewalDate,
  }, "es-US");
  assert.match(spanishAvailability ?? "", /60% usado/);
  assert.match(spanishAvailability ?? "", /se renueva/);

  assert.notEqual(formatAiRenewalDate(renewalDate, "en-US"), formatAiRenewalDate(renewalDate, "es-US"));
  assert.equal(formatAiRenewalDate("not-a-date", "es-US"), null);
});

test("quote builder and quote desk keep rendered workflow copy behind locale keys", () => {
  const builderSource = readFileSync(new URL("../src/views/QuoteBuilderView.tsx", import.meta.url), "utf8");
  const deskSource = readFileSync(new URL("../src/views/QuoteDeskView.tsx", import.meta.url), "utf8");
  const dashboardSource = readFileSync(new URL("../src/components/dashboard/DashboardContext.tsx", import.meta.url), "utf8");
  const directProductProp = /(?:title|subtitle|description|label|ariaLabel|confirmLabel|submitLabel|customerContextBadge|primaryActionLabel|secondaryActionLabel)="[A-ZÁÉÍÓÚÑ¿]/;

  assert.doesNotMatch(builderSource, directProductProp);
  assert.doesNotMatch(deskSource, directProductProp);

  for (const phrase of [
    "Kody prepared a draft</Badge>",
    "Review this AI handoff before creating the quote.",
    "Workspace context:</span>",
    "No line preview supplied yet.</p>",
    "Improve this quote draft.",
  ]) {
    assert.equal(builderSource.includes(phrase), false, `QuoteBuilderView rendered hardcoded copy: ${phrase}`);
  }

  for (const phrase of [
    "Use the same control rail whether you are opening, reviewing, or editing a quote.",
    "Text App opens Messages at the customer's phone number",
    "Review privacy-safe AI activity and context quality for this quote.",
    "This quote has unsaved changes. They will not be included unless you save first.",
    "Did the message leave your phone?",
    "Stored in this browser for up to 12 hours${",
  ]) {
    assert.equal(deskSource.includes(phrase), false, `QuoteDeskView rendered hardcoded copy: ${phrase}`);
  }

  assert.match(builderSource, /t\("quoteBuilder\.handoff\.prepared"\)/);
  for (const trade of ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]) {
    const translatedOptions = builderSource.match(
      new RegExp(`value: "${trade}", label: t\\("domain\\.trade\\.${trade}"\\)`, "g"),
    );
    assert.equal(translatedOptions?.length, 2, `QuoteBuilderView must localize both ${trade} work-type options.`);
  }
  assert.match(deskSource, /t\("quoteDesk\.controls\.title"\)/);
  assert.match(deskSource, /t\("quoteDesk\.composer\.confirmSent"\)/);
  assert.doesNotMatch(dashboardSource, /setError\([^\n]*(?:err|error)\.message\b/);
  assert.match(dashboardSource, /localizedApiError\(/);
  assert.match(dashboardSource, /t\("quoteFeedback\.pdf\.downloaded"\)/);
  assert.match(dashboardSource, /t\("quoteFeedback\.line\.deletedTitle"\)/);
});
