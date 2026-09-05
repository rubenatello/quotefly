import * as ipaddr from "ipaddr.js";

function isTrustedIpv4Proxy(address: ipaddr.IPv4): boolean {
  const [first, second] = address.octets;
  return first === 100
    || first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/**
 * Railway documents `private_ranges 100.0.0.0/8` for safely accepting the
 * edge proxy's forwarding headers. Keep this deliberately narrower than a
 * blanket production trustProxy setting: only Railway's documented range and
 * loopback/RFC1918/IPv6 ULA addresses used by local or private networking are
 * trusted. Public peers must never get to choose request.ip via X-Forwarded-For.
 */
export function isTrustedRailwayProxyAddress(address: string): boolean {
  try {
    // process() canonicalizes IPv4-mapped IPv6 forms before range checks, so
    // `::ffff:6401:0203` cannot bypass or accidentally widen this boundary.
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv4") return isTrustedIpv4Proxy(parsed as ipaddr.IPv4);
    return parsed.range() === "loopback" || parsed.range() === "uniqueLocal";
  } catch {
    return false;
  }
}

export function trustRailwayProxy(address: string): boolean {
  return isTrustedRailwayProxyAddress(address);
}
