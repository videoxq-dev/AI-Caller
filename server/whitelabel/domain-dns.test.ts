import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  licenses, memberships, user, whitelabelDomains, workspaceCommercialOwners, workspaces,
} from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import { claimWhitelabelDomain } from "./domain-service";
import { reconcileWhitelabelDomainDns, type WhitelabelDnsResolver } from "./domain-dns";

let purchaser = "";
let original = "";

async function grant(code: string) {
  await db.insert(licenses).values({
    workspaceId: original,
    purchaserUserId: purchaser,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode: code,
    status: "ACTIVE",
    purchasedAt: new Date(),
  });
}

function resolver(input: {
  a?: string[];
  aaaa?: string[];
  txt?: string[][];
}): WhitelabelDnsResolver {
  return {
    resolve4: vi.fn(async () => input.a ?? []),
    resolve6: vi.fn(async () => input.aaaa ?? []),
    resolveTxt: vi.fn(async () => input.txt ?? []),
  };
}

describe("F12-D2 custom-domain DNS verification", () => {
  beforeEach(async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV4", "203.0.113.25");
    vi.stubEnv("WHITELABEL_PUBLIC_IPV6", "");
    vi.stubEnv("WHITELABEL_CANONICAL_HOST", "app.aicaller.com");
    resetEnvForTests();

    purchaser = randomUUID();
    await db.insert(user).values({
      id: purchaser,
      name: "DNS Purchaser",
      email: purchaser + "@example.com",
      emailVerified: true,
    });
    const [workspace] = await db.insert(workspaces).values({ name: "DNS Business" }).returning();
    original = workspace.id;
    await db.insert(memberships).values({ workspaceId: original, userId: purchaser, role: "OWNER" });
    await db.insert(workspaceCommercialOwners).values({
      workspaceId: original,
      purchaserUserId: purchaser,
      kind: "PRIMARY",
    });
    await grant("CORE");
    await grant("AGENCY_50");
    await grant("WHITELABEL");
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, original));
    await db.delete(user).where(eq(user.id, purchaser));
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  afterAll(async () => closeDatabase());

  it("moves AWAITING_DNS to VERIFIED when A and TXT match and no conflicting AAAA exists", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const token = domain.dns.verificationRecordValue;
    const result = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      txt: [[token]],
    }));
    expect(result).toMatchObject({
      status: "VERIFIED",
      lastErrorCode: null,
    });
    expect(result.aVerifiedAt).toBeInstanceOf(Date);
    expect(result.txtVerifiedAt).toBeInstanceOf(Date);
    expect(result.dnsVerifiedAt).toBeInstanceOf(Date);
  });

  it("records an actionable A-record mismatch without losing a valid TXT check", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const result = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["198.51.100.44"],
      txt: [[domain.dns.verificationRecordValue]],
    }));
    expect(result).toMatchObject({
      status: "AWAITING_DNS",
      lastErrorCode: "DNS_A_MISMATCH",
    });
    expect(result.aVerifiedAt).toBeNull();
    expect(result.txtVerifiedAt).toBeInstanceOf(Date);
  });

  it("reports a missing TXT proof separately from routing DNS", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const result = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      txt: [],
    }));
    expect(result).toMatchObject({
      status: "AWAITING_DNS",
      lastErrorCode: "DNS_TXT_MISSING",
    });
    expect(result.aVerifiedAt).toBeInstanceOf(Date);
    expect(result.txtVerifiedAt).toBeNull();
  });

  it("rejects an AAAA record when this AI Caller edge has no configured IPv6 address", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const result = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      aaaa: ["2001:db8::10"],
      txt: [[domain.dns.verificationRecordValue]],
    }));
    expect(result).toMatchObject({
      status: "AWAITING_DNS",
      lastErrorCode: "DNS_AAAA_MISMATCH",
    });
  });

  it("accepts configured IPv6 only when every returned AAAA address targets this edge", async () => {
    vi.stubEnv("WHITELABEL_PUBLIC_IPV6", "2001:db8::25");
    resetEnvForTests();
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const ok = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      aaaa: ["2001:db8::25"],
      txt: [[domain.dns.verificationRecordValue]],
    }));
    expect(ok.status).toBe("VERIFIED");
  });

  it.each(["ROUTE_PROVISIONING", "CERT_PENDING", "CERT_READY", "ACTIVE"] as const)(
    "refreshes healthy DNS without moving an advanced %s lifecycle backward",
    async (status) => {
      const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
      await db.update(whitelabelDomains).set({
        status,
        dnsVerifiedAt: new Date(Date.now() - 60_000),
      }).where(eq(whitelabelDomains.id, domain.id));

      const refreshed = await reconcileWhitelabelDomainDns(domain.id, resolver({
        a: ["203.0.113.25"],
        txt: [[domain.dns.verificationRecordValue]],
      }));

      expect(refreshed.status).toBe(status);
      expect(refreshed.dnsVerifiedAt).toBeInstanceOf(Date);
      expect(refreshed.lastErrorCode).toBeNull();
    },
  );

  it("marks a previously verified domain DNS_MISMATCH if routing later drifts", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      txt: [[domain.dns.verificationRecordValue]],
    }));
    const drifted = await reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["198.51.100.44"],
      txt: [[domain.dns.verificationRecordValue]],
    }));
    expect(drifted).toMatchObject({
      status: "DNS_MISMATCH",
      lastErrorCode: "DNS_A_MISMATCH",
    });
    expect(drifted.dnsVerifiedAt).toBeNull();
  });

  it("treats ENOTFOUND/ENODATA as missing records rather than crashing verification", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    const missing: WhitelabelDnsResolver = {
      resolve4: vi.fn(async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }),
      resolve6: vi.fn(async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); }),
      resolveTxt: vi.fn(async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }),
    };
    const result = await reconcileWhitelabelDomainDns(domain.id, missing);
    expect(result).toMatchObject({
      status: "AWAITING_DNS",
      lastErrorCode: "DNS_A_MISSING",
    });
  });

  it("does not resurrect a domain whose lifecycle changes while DNS lookup is in flight", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed: WhitelabelDnsResolver = {
      resolve4: vi.fn(async () => { await gate; return ["203.0.113.25"]; }),
      resolve6: vi.fn(async () => { await gate; return []; }),
      resolveTxt: vi.fn(async () => { await gate; return [[domain.dns.verificationRecordValue]]; }),
    };

    const verification = reconcileWhitelabelDomainDns(domain.id, delayed);
    await db.update(whitelabelDomains).set({ status: "REVOKED", updatedAt: new Date() })
      .where(eq(whitelabelDomains.id, domain.id));
    release();

    await expect(verification)
      .rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_NOT_VERIFIABLE", status: 409 });
    const [stored] = await db.select().from(whitelabelDomains)
      .where(eq(whitelabelDomains.id, domain.id));
    expect(stored.status).toBe("REVOKED");
  });

  it("does not verify disabled domain records", async () => {
    const domain = await claimWhitelabelDomain(purchaser, "clients.stratosassist.com");
    await db.update(whitelabelDomains).set({ status: "DISABLED", disabledAt: new Date() })
      .where(eq(whitelabelDomains.id, domain.id));
    await expect(reconcileWhitelabelDomainDns(domain.id, resolver({
      a: ["203.0.113.25"],
      txt: [[domain.dns.verificationRecordValue]],
    }))).rejects.toMatchObject({ code: "WHITELABEL_DOMAIN_NOT_VERIFIABLE", status: 409 });
  });
});
