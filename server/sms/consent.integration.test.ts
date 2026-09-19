import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { contacts, smsConsentEvents, smsConsents, workspaces } from "@/db/schema";
import { getSmsConsentStatus, recordSmsConsent } from "./consent";

describe("persisted SMS consent", () => {
  let workspaceId: string;
  let contactId: string;
  const phone = "+12025550100";
  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Appointment Clinic" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Sarah" }).returning();
    contactId = contact.id;
  });
  afterAll(async () => { await closeDatabase(); });

  it("keeps appointment consent after booking and preserves revocation evidence", async () => {
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "WEB_FORM",
      sourceReference: "chat-1", consentStatement: "Send appointment updates",
    });
    expect(await getSmsConsentStatus(workspaceId, phone, "TRANSACTIONAL")).toBe("OPTED_IN");
    expect(await getSmsConsentStatus(workspaceId, phone, "MARKETING")).toBe("UNKNOWN");
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_OUT", source: "INBOUND_SMS", sourceReference: "stop-1",
    });
    expect(await getSmsConsentStatus(workspaceId, phone, "TRANSACTIONAL")).toBe("OPTED_OUT");
    expect(await db.select().from(smsConsents)).toHaveLength(1);
    expect(await db.select().from(smsConsentEvents)).toHaveLength(2);
  });

  it("does not let consent from another workspace authorize this workspace", async () => {
    const [other] = await db.insert(workspaces).values({ name: "Other Business" }).returning();
    const [otherContact] = await db.insert(contacts).values({ workspaceId: other.id }).returning();
    await recordSmsConsent(other.id, otherContact.id, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "STAFF_ENTRY",
    });
    expect(await getSmsConsentStatus(workspaceId, phone, "TRANSACTIONAL")).toBe("UNKNOWN");
    expect(await getSmsConsentStatus(other.id, phone, "TRANSACTIONAL")).toBe("OPTED_IN");
  });

  it("does not accept a foreign contact ID for a consent write", async () => {
    const [other] = await db.insert(workspaces).values({ name: "Other Business" }).returning();
    await expect(recordSmsConsent(other.id, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "STAFF_ENTRY",
    })).rejects.toMatchObject({ code: "CONTACT_NOT_FOUND" });
    expect(await db.select().from(smsConsentEvents)).toHaveLength(0);
  });
});
