import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { licenses, memberships, user, webchatSessions, webchatWidgets, workspaces } from "@/db/schema";
import {
  createAdditionalWebchatWidget,
  createOrResumeWebchatSession,
  ensureWebchatWidget,
  getPublicWebchatWidget,
  listWebchatWidgets,
  updateWebchatWidgetById,
} from "./repository";

const users: string[] = [];
const workspaceIds: string[] = [];

async function ownerWithWorkspace() {
  const userId = randomUUID();
  users.push(userId);
  await db.insert(user).values({
    id: userId,
    name: "Widget Buyer",
    email: `${userId}@example.com`,
    emailVerified: true,
  });
  const [workspace] = await db.insert(workspaces).values({ name: "Widget Business" }).returning();
  workspaceIds.push(workspace.id);
  await db.insert(memberships).values({ workspaceId: workspace.id, userId, role: "OWNER" });
  return { userId, workspaceId: workspace.id };
}

async function grant(userId: string, workspaceId: string, productCode: "CORE" | "UNLIMITED", status: "ACTIVE" | "REFUNDED" = "ACTIVE") {
  const [license] = await db.insert(licenses).values({
    workspaceId,
    purchaserUserId: userId,
    source: "MANUAL",
    externalPurchaseId: randomUUID(),
    productCode,
    status,
    purchasedAt: new Date(),
  }).returning();
  return license;
}

describe("Unlimited web chat widget lifecycle", () => {
  afterEach(async () => {
    for (const id of workspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    workspaceIds.length = 0;
    for (const id of users) await db.delete(user).where(eq(user.id, id));
    users.length = 0;
  });

  afterAll(async () => closeDatabase());

  it("keeps Core on one primary widget and blocks additional widget creation", async () => {
    const { userId, workspaceId } = await ownerWithWorkspace();
    await grant(userId, workspaceId, "CORE");
    const primary = await ensureWebchatWidget(workspaceId);

    expect(primary.isPrimary).toBe(true);
    expect(await listWebchatWidgets(workspaceId)).toHaveLength(1);
    await expect(createAdditionalWebchatWidget(workspaceId, { name: "Campaign chat" }))
      .rejects.toMatchObject({ code: "UNLIMITED_WIDGETS_REQUIRED", status: 403 });
    expect(await getPublicWebchatWidget(primary.publicKey)).not.toBeNull();
  });

  it("lets Unlimited create multiple distinct widgets without a commercial count cap", async () => {
    const { userId, workspaceId } = await ownerWithWorkspace();
    await grant(userId, workspaceId, "CORE");
    await grant(userId, workspaceId, "UNLIMITED");

    const primary = await ensureWebchatWidget(workspaceId);
    const campaign = await createAdditionalWebchatWidget(workspaceId, {
      name: "Campaign landing page",
      greeting: "Ask about the campaign.",
      launcherLabel: "Campaign chat",
    });
    const support = await createAdditionalWebchatWidget(workspaceId, { name: "Support site" });

    expect(primary.isPrimary).toBe(true);
    expect(campaign.isPrimary).toBe(false);
    expect(support.isPrimary).toBe(false);
    expect(new Set([primary.publicKey, campaign.publicKey, support.publicKey]).size).toBe(3);
    expect((await listWebchatWidgets(workspaceId)).map((widget) => widget.id)).toEqual(
      expect.arrayContaining([primary.id, campaign.id, support.id]),
    );
    await expect(getPublicWebchatWidget(campaign.publicKey)).resolves.toMatchObject({
      publicKey: campaign.publicKey,
      greeting: "Ask about the campaign.",
      launcherLabel: "Campaign chat",
    });
  });

  it("binds sessions to the exact widget and never resumes a token through another widget", async () => {
    const { userId, workspaceId } = await ownerWithWorkspace();
    await grant(userId, workspaceId, "UNLIMITED");
    const primary = await ensureWebchatWidget(workspaceId);
    const secondary = await createAdditionalWebchatWidget(workspaceId, { name: "Secondary" });

    const session = await createOrResumeWebchatSession({ widgetKey: secondary.publicKey });
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected widget session.");

    const [stored] = await db.select().from(webchatSessions).where(eq(webchatSessions.id, session.sessionId));
    expect(stored.widgetId).toBe(secondary.id);

    const mismatchedResume = await createOrResumeWebchatSession({
      widgetKey: primary.publicKey,
      sessionToken: session.sessionToken,
    });
    expect(mismatchedResume?.sessionId).not.toBe(session.sessionId);
    expect(mismatchedResume?.widget.publicKey).toBe(primary.publicKey);
  });

  it("preserves secondary widget data but stops serving it after Unlimited is refunded", async () => {
    const { userId, workspaceId } = await ownerWithWorkspace();
    const unlimited = await grant(userId, workspaceId, "UNLIMITED");
    const primary = await ensureWebchatWidget(workspaceId);
    const secondary = await createAdditionalWebchatWidget(workspaceId, { name: "Preserved campaign" });
    const session = await createOrResumeWebchatSession({ widgetKey: secondary.publicKey });
    expect(session).not.toBeNull();

    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.id, unlimited.id));

    await expect(getPublicWebchatWidget(primary.publicKey)).resolves.not.toBeNull();
    await expect(getPublicWebchatWidget(secondary.publicKey)).resolves.toBeNull();
    await expect(createOrResumeWebchatSession({ widgetKey: secondary.publicKey })).resolves.toBeNull();
    await expect(createOrResumeWebchatSession({
      widgetKey: secondary.publicKey,
      sessionToken: session!.sessionToken,
    })).resolves.toBeNull();

    const preserved = await db.select().from(webchatWidgets).where(and(
      eq(webchatWidgets.workspaceId, workspaceId),
      eq(webchatWidgets.id, secondary.id),
    ));
    expect(preserved).toHaveLength(1);
    await expect(updateWebchatWidgetById(workspaceId, secondary.id, { name: "Changed after refund" }))
      .rejects.toMatchObject({ code: "UNLIMITED_WIDGETS_REQUIRED", status: 403 });
    await expect(updateWebchatWidgetById(workspaceId, secondary.id, { enabled: false })).resolves.toMatchObject({
      id: secondary.id,
      enabled: false,
    });
  });

  it("lets Unlimited disable and re-enable an additional widget without changing its public key", async () => {
    const { userId, workspaceId } = await ownerWithWorkspace();
    await grant(userId, workspaceId, "UNLIMITED");
    const widget = await createAdditionalWebchatWidget(workspaceId, { name: "Seasonal" });

    const disabled = await updateWebchatWidgetById(workspaceId, widget.id, { enabled: false });
    expect(disabled.publicKey).toBe(widget.publicKey);
    await expect(getPublicWebchatWidget(widget.publicKey)).resolves.toBeNull();

    const enabled = await updateWebchatWidgetById(workspaceId, widget.id, { enabled: true });
    expect(enabled.publicKey).toBe(widget.publicKey);
    await expect(getPublicWebchatWidget(widget.publicKey)).resolves.not.toBeNull();
  });
});
