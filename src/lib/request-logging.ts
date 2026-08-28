type RequestLogInput = {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  remoteAddress?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
};

function requestPathname(url: string): string {
  return url.split("?", 1)[0] || "/";
}

export function safeRequestLogSerializer(request: RequestLogInput) {
  return {
    method: request.method,
    // Never persist query strings. OAuth codes/state and customer search PII
    // arrive before route handlers and must be excluded at the logger boundary.
    url: requestPathname(request.url ?? "/"),
    hostname: request.hostname,
    remoteAddress: request.ip ?? request.remoteAddress ?? request.socket?.remoteAddress,
    remotePort: request.socket?.remotePort,
  };
}
