import { resolve4, resolve6, resolveTxt } from "node:dns/promises";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { whitelabelDomains } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { getWhitelabelDomainInfrastructure } from "./domain-config";
import { decryptWhitelabelDomainVerificationToken } from "./domain-token";

export type WhitelabelDnsResolver = {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
};

const defaultResolver: WhitelabelDnsResolver = { resolve4, resolve6, resolveTxt };

function normalizeAddress(address: string) {
  if (!address.includes(":")) return address;
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

function dnsMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error
    && ["ENOTFOUND", "ENODATA"].includes(String((error as { code?: unknown }).code)));
}

async function optionalLookup<T>(work: () => Promise<T>, empty: T) {
  try {
    return await work();
  } catch (error) {
    if (dnsMissing(error)) return empty;
    throw error;
  }
}

function verificationError(input: {
  a: string[];
  expectedA: string;
  txt: string[];
  expectedTxt: string;
  aaaa: string[];
  expectedAaaa: string | null;
}) {
  if (input.a.length === 0) {
    return { code: "DNS_A_MISSING", message: `Add an A record pointing to ${input.expectedA}.` };
  }
  if (!input.a.every((address) => address === input.expectedA)) {
    return {
      code: "DNS_A_MISMATCH",
      message: `The A record must point only to ${input.expectedA}. Found: ${input.a.join(", ")}.`,
    };
  }
  if (input.txt.length === 0) {
    return { code: "DNS_TXT_MISSING", message: "Add the AI Caller TXT verification record shown in Whitelabel settings." };
  }
  if (!input.txt.includes(input.expectedTxt)) {
    return { code: "DNS_TXT_MISMATCH", message: "The TXT verification value does not match this Whitelabel account." };
  }
  if (input.aaaa.length > 0) {
    if (!input.expectedAaaa) {
      return {
        code: "DNS_AAAA_MISMATCH",
        message: "Remove the AAAA record or point it to an AI Caller IPv6 edge before verification.",
      };
    }
    const expected = normalizeAddress(input.expectedAaaa);
    if (!input.aaaa.map(normalizeAddress).every((address) => address === expected)) {
      return {
        code: "DNS_AAAA_MISMATCH",
        message: `Every AAAA record must point to ${input.expectedAaaa}.`,
      };
    }
  }
  return null;
}

export async function reconcileWhitelabelDomainDns(
  domainId: string,
  resolver: WhitelabelDnsResolver = defaultResolver,
) {
  const [domain] = await db.select().from(whitelabelDomains)
    .where(eq(whitelabelDomains.id, domainId))
    .limit(1);
  if (!domain) {
    throw new AppError("WHITELABEL_DOMAIN_NOT_FOUND", "Custom domain not found.", 404);
  }
  if (["DISABLED", "DISABLING", "REVOKED"].includes(domain.status)) {
    throw new AppError("WHITELABEL_DOMAIN_NOT_VERIFIABLE", "This custom domain is not active for DNS verification.", 409);
  }

  const infra = getWhitelabelDomainInfrastructure(true);
  const token = decryptWhitelabelDomainVerificationToken(domain.verificationTokenEncrypted);
  const txtName = `_ai-caller-verify.${domain.hostname}`;
  const expectedTxt = `aicaller-verification=${token}`;
  const now = new Date();

  let a: string[];
  let aaaa: string[];
  let txtRows: string[][];
  try {
    [a, aaaa, txtRows] = await Promise.all([
      optionalLookup(() => resolver.resolve4(domain.hostname), []),
      optionalLookup(() => resolver.resolve6(domain.hostname), []),
      optionalLookup(() => resolver.resolveTxt(txtName), []),
    ]);
  } catch {
    const [updated] = await db.update(whitelabelDomains).set({
      lastCheckedAt: now,
      lastErrorCode: "DNS_LOOKUP_FAILED",
      lastErrorMessage: "DNS lookup could not be completed. Try again shortly.",
      updatedAt: now,
    }).where(eq(whitelabelDomains.id, domain.id)).returning();
    return updated;
  }

  const txt = txtRows.map((parts) => parts.join(""));
  const error = verificationError({
    a,
    expectedA: infra.ipv4!,
    txt,
    expectedTxt,
    aaaa,
    expectedAaaa: infra.ipv6,
  });

  const aOk = a.length > 0 && a.every((address) => address === infra.ipv4);
  const txtOk = txt.includes(expectedTxt);
  const aaaaOk = aaaa.length === 0 || (Boolean(infra.ipv6)
    && aaaa.map(normalizeAddress).every((address) => address === normalizeAddress(infra.ipv6!)));
  const verified = aOk && txtOk && aaaaOk;
  const wasVerified = Boolean(domain.dnsVerifiedAt)
    || !["DRAFT", "AWAITING_DNS"].includes(domain.status);

  const [updated] = await db.update(whitelabelDomains).set({
    status: verified ? "VERIFIED" : wasVerified ? "DNS_MISMATCH" : "AWAITING_DNS",
    aVerifiedAt: aOk ? now : null,
    txtVerifiedAt: txtOk ? now : null,
    dnsVerifiedAt: verified ? now : null,
    lastCheckedAt: now,
    lastErrorCode: error?.code ?? null,
    lastErrorMessage: error?.message ?? null,
    updatedAt: now,
  }).where(and(
    eq(whitelabelDomains.id, domain.id),
    ne(whitelabelDomains.status, "DISABLED"),
  )).returning();

  if (!updated) {
    throw new AppError("WHITELABEL_DOMAIN_NOT_VERIFIABLE", "This custom domain is no longer active for DNS verification.", 409);
  }
  return updated;
}
