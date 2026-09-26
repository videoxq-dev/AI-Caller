import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { aiAgents, workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";
import { setWorkspaceAgentCapabilities } from "@/server/agent/service";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { getAgentSetup, getBusinessSetup, getSetupStatus, saveAgentSetup, saveBusinessSetup } from "./repository";

describe("onboarding persistence", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Onboarding Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists business, hours, AI behavior and setup progress", async () => {
    await saveBusinessSetup(workspaceId, {
      businessName: "Brightside Auto Spa",
      industry: "Auto Repair",
      websiteUrl: "https://example.com",
      phone: "+15555550100",
      address: "1 Main Street",
      city: "Miami",
      state: "Florida",
      postalCode: "33101",
      country: "US",
      serviceRadius: "Within 20 miles",
      timezone: "America/New_York",
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        enabled: dayOfWeek < 6,
        openTime: dayOfWeek < 6 ? "08:00" : null,
        closeTime: dayOfWeek < 6 ? "18:00" : null,
      })),
      completeStep: true,
    });

    await saveAgentSetup(workspaceId, {
      name: "Mia",
      tone: "Friendly & professional",
      primaryGoal: "Book appointments",
      whenUnsure: "Escalate to a human",
      escalationMessage: "Escalate complaints to the team.",
      guardrails: ["Never invent pricing", "Only answer based on approved business information"],
      voice: {
        profileKey: "ava-us-1",
        language: "en-US",
        speakingRate: 1,
        recordingPolicy: "ANNOUNCE",
        afterHoursEnabled: true,
      },
      qualification: { enabled: false, criteria: [] },
      completeStep: true,
    });

    const business = await getBusinessSetup(workspaceId);
    const agent = await getAgentSetup(workspaceId);
    const status = await getSetupStatus(workspaceId);

    expect(business.profile?.businessName).toBe("Brightside Auto Spa");
    expect(business.hours).toHaveLength(7);
    expect(agent.agent?.name).toBe("Mia");
    expect(agent.agent?.behaviorSettings).toEqual({
      guardrails: ["Never invent pricing", "Only answer based on approved business information"],
      voice: {
        profileKey: "ava-us-1",
        language: "en-US",
        speakingRate: 1,
        recordingPolicy: "ANNOUNCE",
        afterHoursEnabled: true,
      },
      qualification: { enabled: false, criteria: [] },
    });
    expect(status.completedCount).toBe(2);
    expect(status.steps.business).toBe(true);
    expect(status.steps.ai).toBe(true);
  });
  it("does not erase capability restrictions when the normal AI Agent form is saved", async () => {
    await saveAgentSetup(workspaceId, {
      name: "Mia", tone: "Friendly & professional", primaryGoal: "Answer questions",
      whenUnsure: "Escalate to a human", guardrails: [],
      voice: { profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
        recordingPolicy: "ANNOUNCE", afterHoursEnabled: true },
      qualification: { enabled: false, criteria: [] }, completeStep: false,
    });
    await setWorkspaceAgentCapabilities(workspaceId, {
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: false,
    });
    await saveAgentSetup(workspaceId, {
      name: "Mia", tone: "Professional", primaryGoal: "Answer questions",
      whenUnsure: "Escalate to a human", guardrails: ["Never invent pricing"],
      voice: { profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
        recordingPolicy: "ANNOUNCE", afterHoursEnabled: true },
      qualification: { enabled: false, criteria: [] }, completeStep: false,
    });
    const saved = await getAgentSetup(workspaceId);
    expect((saved.agent?.behaviorSettings.capabilities as Record<string, boolean>).BOOK_APPOINTMENT)
      .toBe(false);
    expect(saved.agent?.behaviorSettings.guardrails).toEqual(["Never invent pricing"]);
  });

  it("recognizes previously activated and later paused agents without a live progress marker", async () => {
    await db.insert(aiAgents).values({ workspaceId, name: "Legacy agent", status: "DRAFT" });
    expect((await getSetupStatus(workspaceId)).steps.live).toBe(false);
    await db.update(aiAgents).set({ status: "ACTIVE" }).where(eq(aiAgents.workspaceId, workspaceId));
    expect((await getSetupStatus(workspaceId)).steps.live).toBe(true);
    await db.update(aiAgents).set({ status: "PAUSED" }).where(eq(aiAgents.workspaceId, workspaceId));
    expect((await getSetupStatus(workspaceId)).steps.live).toBe(true);
  });

});
