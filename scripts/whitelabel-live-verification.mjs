import { isIP } from "node:net";

export function checkWhitelabelPublicDns({
  a, aaaa, txt, expectedIpv4, expectedIpv6 = null, expectedTxt,
}) {
  if (isIP(expectedIpv4) !== 4) throw new Error("Expected edge IPv4 is invalid.");
  if (!a.length || a.some((address) => address !== expectedIpv4)) {
    throw new Error("DNS_A_MISMATCH: all A records must point to the configured AI Caller edge.");
  }
  if (expectedIpv6) {
    if (isIP(expectedIpv6) !== 6 || aaaa.length && aaaa.some((address) =>
      new URL(`http://[${address}]`).hostname !== new URL(`http://[${expectedIpv6}]`).hostname
    )) throw new Error("DNS_AAAA_MISMATCH: AAAA records point away from the configured edge.");
  } else if (aaaa.length) {
    throw new Error("DNS_AAAA_MISMATCH: an unexpected IPv6 edge record is present.");
  }
  if (!expectedTxt || !expectedTxt.startsWith("aicaller-verification=")) {
    throw new Error("Provide the exact purchaser TXT proof through WHITELABEL_TEST_TXT.");
  }
  if (!txt.includes(expectedTxt)) {
    throw new Error("DNS_TXT_MISMATCH: purchaser ownership proof is missing or incorrect.");
  }
}

export function checkWhitelabelHoldingResponse({ statusCode, body, hostname }) {
  if (statusCode !== 200 || !body || typeof body !== "object"
    || body.status !== "domain-ready" || body.host !== hostname) {
    throw new Error("TLS_ROUTE_NOT_READY: HTTPS did not reach this domain's holding response.");
  }
}

export function checkWhitelabelHttpReachability({ statusCode }) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode >= 600) {
    throw new Error("HTTP_EDGE_NOT_READY: public port 80 did not return a valid HTTP response.");
  }
}

export function checkWhitelabelStoredCertificateExpiry({ servedExpiry, storedExpiry, toleranceMs = 1000 }) {
  const served = servedExpiry instanceof Date ? servedExpiry : new Date(servedExpiry);
  const stored = storedExpiry instanceof Date ? storedExpiry : new Date(storedExpiry);
  if (!Number.isFinite(served.getTime()) || !Number.isFinite(stored.getTime())
    || Math.abs(stored.getTime() - served.getTime()) > toleranceMs) {
    throw new Error("Live database certificate expiry does not match the certificate served by the edge.");
  }
}
