import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { workspaces } from "@/db/schema";
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
});
