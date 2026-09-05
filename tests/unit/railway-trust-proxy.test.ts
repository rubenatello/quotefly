import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  isTrustedRailwayProxyAddress,
  trustRailwayProxy,
} from "../../src/lib/railway-trust-proxy";

async function requestIp(
  remoteAddress: string,
  forwardedFor?: string,
): Promise<{ ip: string; ips: string[] }> {
  const app = Fastify({ trustProxy: trustRailwayProxy });
  app.get("/", (request) => ({ ip: request.ip, ips: request.ips }));
  await app.ready();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress,
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  } finally {
    await app.close();
  }
}

test("ignores forged X-Forwarded-For hops left of an untrusted client", async () => {
  const response = await requestIp(
    "100.12.34.56",
    "198.51.100.10, 203.0.113.40",
  );
  assert.equal(response.ip, "203.0.113.40");
  assert.deepEqual(response.ips, ["100.12.34.56", "203.0.113.40"]);
});

test("does not trust X-Forwarded-For from an untrusted direct peer", async () => {
  const response = await requestIp("203.0.113.91", "198.51.100.25");
  assert.equal(response.ip, "203.0.113.91");
  assert.deepEqual(response.ips, ["203.0.113.91"]);
});

test("canonicalizes IPv4-mapped IPv6 Railway peers without trusting public IPv6 peers", async () => {
  assert.equal(isTrustedRailwayProxyAddress("::ffff:6401:0203"), true);
  assert.equal(isTrustedRailwayProxyAddress("2001:db8::100"), false);

  const mappedRailwayPeer = await requestIp("::FFFF:100.1.2.3", "2001:db8::42");
  assert.equal(mappedRailwayPeer.ip, "2001:db8::42");

  const publicIpv6Peer = await requestIp("2001:db8::100", "198.51.100.25");
  assert.equal(publicIpv6Peer.ip, "2001:db8::100");
});
