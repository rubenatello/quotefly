import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { addWorkspaceMemberViaApi } from "./helpers";

function response(
  status: number,
  options: {
    headers?: Record<string, string>;
    json?: unknown;
    text?: string;
  } = {},
): APIResponse {
  const headers = options.headers ?? {};
  return {
    status: () => status,
    url: () => "http://127.0.0.1:4100/v1/auth/signin",
    headers: () => headers,
    headersArray: () => Object.entries(headers).map(([name, value]) => ({ name, value })),
    json: async () => options.json ?? {},
    text: async () => options.text ?? "fixture response",
  } as APIResponse;
}

function fixtureRequest(signInResponses: APIResponse[]) {
  let signInAttempts = 0;
  const request = {
    post: async (url: string) => {
      if (url.endsWith("/v1/org/users")) {
        return response(201, { json: { member: { id: "membership-1" } } });
      }
      if (!url.endsWith("/v1/auth/signin")) {
        throw new Error(`Unexpected fixture URL: ${url}`);
      }
      const next = signInResponses[signInAttempts++];
      if (!next) throw new Error("Fixture made an unexpected extra sign-in attempt.");
      return next;
    },
  } as unknown as APIRequestContext;

  return { request, signInAttempts: () => signInAttempts };
}

const successfulSignIn = () => response(200, {
  headers: { "set-cookie": "qf_session=fixture-token; Path=/; HttpOnly" },
  json: {
    user: { id: "user-1", email: "member@example.com", fullName: "Member" },
    tenant: { id: "tenant-1", name: "Fixture Tenant", slug: "fixture-tenant" },
  },
});

test("member fixture honors Retry-After once before a successful sign-in", async () => {
  const fixture = fixtureRequest([
    response(429, { headers: { "retry-after": "0" } }),
    successfulSignIn(),
  ]);

  const member = await addWorkspaceMemberViaApi(fixture.request, {
    cookieHeader: "qf_session=owner-token",
  } as never);

  expect(fixture.signInAttempts()).toBe(2);
  expect(member.cookieHeader).toBe("qf_session=fixture-token");
  expect(member.membershipId).toBe("membership-1");
});

for (const retryAfter of [undefined, "soon", "61"]) {
  test(`member fixture does not retry an invalid Retry-After value: ${retryAfter ?? "missing"}`, async () => {
    const fixture = fixtureRequest([
      response(429, { headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } }),
    ]);

    await expect(addWorkspaceMemberViaApi(fixture.request, {
      cookieHeader: "qf_session=owner-token",
    } as never)).rejects.toThrow("Expected 200");
    expect(fixture.signInAttempts()).toBe(1);
  });
}

test("member fixture never makes a third sign-in attempt after a repeated 429", async () => {
  const fixture = fixtureRequest([
    response(429, { headers: { "retry-after": "0" } }),
    response(429, { headers: { "retry-after": "0" } }),
  ]);

  await expect(addWorkspaceMemberViaApi(fixture.request, {
    cookieHeader: "qf_session=owner-token",
  } as never)).rejects.toThrow("Expected 200");
  expect(fixture.signInAttempts()).toBe(2);
});
