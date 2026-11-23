/**
 * @vellum/security - SSRF guard for outbound integration URLs.
 *
 * Only HTTPS is permitted in production (HTTP is gated behind an explicit
 * test-only option). Credentials, IP-literal hosts, internal hostnames, and
 * any DNS answer that resolves into a private/loopback/link-local/multicast/
 * reserved range are rejected, which also closes the common DNS-rebinding path
 * where only the first answer is safe.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_URL_LENGTH = 2_048;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
];

/** VellumError-compatible failure raised for every blocked URL. */
export class SsrfBlockedError extends Error {
  public readonly code = "SSRF_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return [a, b, c, d];
}

function isUnsafeIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (octets === null) {
    return true;
  }
  const [a = -1, b = -1, c = -1] = octets;
  if (a === 0 || a === 127) {
    return true; // 0/8 (including 0.0.0.0) and 127/8 loopback
  }
  if (a === 10) {
    return true; // RFC1918 10/8
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true; // RFC1918 172.16/12
  }
  if (a === 192 && b === 168) {
    return true; // RFC1918 192.168/16
  }
  if (a === 169 && b === 254) {
    return true; // link-local / cloud metadata 169.254/16
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // CGNAT 100.64/10
  }
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return true; // IETF protocol assignments 192.0.0/24 & TEST-NET-1 192.0.2/24
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true; // Benchmarking 198.18/15
  }
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
    return true; // TEST-NET-2 & TEST-NET-3
  }
  if (a >= 224) {
    return true; // Multicast 224/4, Reserved 240/4, Broadcast 255.255.255.255
  }
  return false;
}

/** Convert an IPv4-mapped or IPv4-compatible IPv6 literal to its embedded dotted IPv4 form. */
function mappedIpv4(host: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  const dottedAddress = dotted?.[1];
  if (dottedAddress !== undefined) {
    return dottedAddress;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  const high = hex?.[1];
  const low = hex?.[2];
  if (high !== undefined && low !== undefined) {
    const hi = Number.parseInt(high, 16);
    const lo = Number.parseInt(low, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

function isUnsafeAddress(address: string): boolean {
  // Strip IPv6 zone identifiers (e.g. fe80::1%eth0).
  const zoneIdx = address.indexOf("%");
  const host = (zoneIdx >= 0 ? address.slice(0, zoneIdx) : address).toLowerCase();

  const embedded = mappedIpv4(host);
  if (embedded !== null) {
    return isUnsafeIpv4(embedded);
  }

  if (
    host === "::" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:0" ||
    host === "0:0:0:0:0:0:0:1"
  ) {
    return true; // unspecified / loopback
  }

  const family = isIP(host);
  if (family === 4) {
    return isUnsafeIpv4(host);
  }
  if (family === 6) {
    const groups = host.split(":");
    const firstGroup = groups[0] ?? "";
    const secondGroup = groups[1] ?? "";
    const first = Number.parseInt(firstGroup === "" ? "0" : firstGroup, 16);
    const second = Number.parseInt(secondGroup === "" ? "0" : secondGroup, 16);
    if (Number.isNaN(first)) {
      return true;
    }
    if (first >= 0xfe80 && first <= 0xfebf) {
      return true; // fe80::/10 link-local
    }
    if (first >= 0xfec0 && first <= 0xfeff) {
      return true; // fec0::/10 deprecated site-local
    }
    if (first >= 0xfc00 && first <= 0xfdff) {
      return true; // fc00::/7 unique-local
    }
    if (first >= 0xff00) {
      return true; // ff00::/8 multicast
    }
    if (first === 0x0064 && second === 0xff9b) {
      return true; // 64:ff9b::/96 NAT64 well-known prefix
    }
    if (first === 0x2002) {
      return true; // 2002::/16 6to4 relay (can embed private IPv4)
    }
    if (first === 0x2001 && (second === 0x0000 || second === 0x0db8)) {
      return true; // Teredo 2001:0000::/32 & Documentation 2001:db8::/32
    }
    return false;
  }

  // Anything we cannot classify fails closed.
  return true;
}

/**
 * Assert that a URL is safe to fetch from a server-side integration.
 *
 * @throws {SsrfBlockedError} with `code === "SSRF_BLOCKED"` on any violation.
 */
export async function assertSafeExternalUrl(
  urlString: string,
  opts: { allowHttpInTests?: boolean } = {},
): Promise<void> {
  if (
    typeof urlString !== "string" ||
    urlString.length === 0 ||
    urlString.length > MAX_URL_LENGTH ||
    CONTROL_CHAR_REGEX.test(urlString)
  ) {
    throw new SsrfBlockedError("Malformed external URL");
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new SsrfBlockedError("Malformed external URL");
  }

  const testAllowance = opts.allowHttpInTests === true && process.env["NODE_ENV"] === "test";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && testAllowance)) {
    throw new SsrfBlockedError(`Blocked URL protocol '${url.protocol}'`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new SsrfBlockedError("Credentials are not permitted in external URLs");
  }

  // Explicit test allowance: local mock servers may use http:// and numeric
  // loopback hosts. Production always performs the full checks below.
  if (testAllowance) {
    return;
  }

  const rawHost = url.hostname.toLowerCase();
  const unbracketed = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
  const hostname = unbracketed.replace(/\.+$/, "");
  if (hostname === "") {
    throw new SsrfBlockedError("External URL has no hostname");
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new SsrfBlockedError("Internal or local hostnames are not permitted");
  }

  const numericHost = /^[0-9.]+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname);
  if (isIP(hostname) !== 0 || numericHost) {
    throw new SsrfBlockedError("Non-FQDN numeric hosts are not permitted");
  }

  try {
    const resolved = await lookup(hostname, { all: true });
    if (resolved.length === 0) {
      throw new SsrfBlockedError("External host resolved to no addresses");
    }
    // Check every answer, not just the first: a single private address in the
    // set is enough to block (DNS rebinding / multi-homed host defence).
    for (const entry of resolved) {
      const address: unknown = entry?.address;
      if (typeof address !== "string" || isUnsafeAddress(address)) {
        throw new SsrfBlockedError("External host resolved to a blocked address");
      }
    }
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw error;
    }
    throw new SsrfBlockedError("DNS resolution failed for external host");
  }
}
