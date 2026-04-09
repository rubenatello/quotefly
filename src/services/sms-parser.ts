export interface ParsedJobLead {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  rawScope: string;
}

export function parseInboundJobText(message: string): ParsedJobLead {
  const emailMatch = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = message.match(/\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);

  const nameHint = message.match(/customer\s+([A-Za-z]+\s+[A-Za-z]+)/i);

  return {
    customerName: nameHint?.[1],
    customerPhone: phoneMatch?.[0],
    customerEmail: emailMatch?.[0],
    rawScope: message.trim(),
  };
}
