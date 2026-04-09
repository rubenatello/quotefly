const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function getToken(): string | null {
  return localStorage.getItem("qf_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `Request failed: ${res.status}`;
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type AuthPayload = {
  token: string;
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; name: string; slug: string };
};

export const api = {
  auth: {
    signup: (body: {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
    }) => request<AuthPayload>("/v1/auth/signup", { method: "POST", body: JSON.stringify(body) }),

    signin: (body: { email: string; password: string }) =>
      request<AuthPayload>("/v1/auth/signin", { method: "POST", body: JSON.stringify(body) }),
  },

  branding: {
    get: (tenantId: string) =>
      request<{ branding: { primaryColor: string; templateId: string; logoUrl?: string | null } | null }>(
        `/v1/tenants/${tenantId}/branding`,
      ),

    save: (
      tenantId: string,
      body: { logoUrl?: string | null; primaryColor: string; templateId: string },
    ) =>
      request<{ branding: { primaryColor: string; templateId: string; logoUrl?: string | null } }>(
        `/v1/tenants/${tenantId}/branding`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
  },
};
