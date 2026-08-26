function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quote providers need work facts, not customer identity. Keep deterministic
 * resolution on the server and minimize every provider-bound prompt/context.
 */
export function minimizeQuoteProviderInput(
  value: string | null | undefined,
  options: {
    customerNames?: readonly (string | null | undefined)[];
    sensitiveValues?: readonly (string | null | undefined)[];
  } = {},
) {
  let minimized = value ?? "";
  minimized = minimized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[customer email removed]")
    .replace(/(?:\+?1[\s().-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/g, "[customer phone removed]");
  const names = Array.from(new Set((options.customerNames ?? [])
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name))))
    .sort((left, right) => right.length - left.length);
  for (const name of names) {
    minimized = minimized.replace(new RegExp(escapeRegExp(name), "gi"), "[customer name removed]");
  }
  const sensitiveValues = Array.from(new Set((options.sensitiveValues ?? [])
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))))
    .sort((left, right) => right.length - left.length);
  for (const sensitiveValue of sensitiveValues) {
    minimized = minimized.replace(
      new RegExp(escapeRegExp(sensitiveValue), "gi"),
      "[customer identifier removed]",
    );
  }
  return minimized;
}

/**
 * Fail-safe final boundary for every quote chat-completion request. Callers may
 * pre-minimize for clarity, but the provider gateway input is built only from
 * this returned prompt/context pair so neither channel can bypass redaction.
 */
export function minimizeQuoteProviderBoundary(input: {
  prompt: string;
  context?: string | null;
  customerNames?: readonly (string | null | undefined)[];
  sensitiveValues?: readonly (string | null | undefined)[];
}) {
  const options = {
    customerNames: input.customerNames,
    sensitiveValues: input.sensitiveValues,
  };
  return {
    prompt: minimizeQuoteProviderInput(input.prompt, options),
    context: minimizeQuoteProviderInput(input.context, options),
  } as const;
}
