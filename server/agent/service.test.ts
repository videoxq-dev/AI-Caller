import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { aiAgents, setupProgress, workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AppError } from "@/server/http/errors";
import { defaultAgentCapabilities } from "./capabilities";
import { buildAgentTestContext } from "@/server/orchestrator/context";
import {
  getWorkspaceAgent, getAgentPolicySnapshot, requireActiveWorkspaceAgent,
  setWorkspaceAgentStatus, setWorkspaceAgentCapabilities,
} from "./service";

describe("one workspace agent service", () => {
  let workspaceId = "";
  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Agent service test" }).returning();
    workspaceId = workspace.id;
  });
  afterAll(async () => { await closeDatabase(); });

  it("requires an existing agent and does not create a second agent", async () => {
    await expect(getWorkspaceAgent(workspaceId)).resolves.toBeNull();
    await expect(setWorkspaceAgentStatus(workspaceId, "ACTIVE"))
      .rejects.toMatchObject({ code: "AGENT_NOT_CONFIGURED" });
    const [agent] = await db.insert(aiAgents).values({ workspaceId, name: "Mia" }).returning();
    expect((await getAgentPolicySnapshot(workspaceId)).agentId).toBe(agent.id);
  });

  it("enforces persisted DRAFT/ACTIVE/PAUSED states and retains disabled booking", async () => {
    await db.insert(aiAgents).values({
      workspaceId, name: "Mia",
      behaviorSettings: { voice: { profileKey: "ava-us-1" } },
    });
    await expect(requireActiveWorkspaceAgent(workspaceId))
      .rejects.toMatchObject({ code: "AGENT_NOT_ACTIVE" });
    await setWorkspaceAgentStatus(workspaceId, "ACTIVE");
    const [setup] = await db.select().from(setupProgress)
      .where(eq(setupProgress.workspaceId, workspaceId));
    expect(setup?.liveCompletedAt).toBeInstanceOf(Date);
    await requireActiveWorkspaceAgent(workspaceId, "ANSWER_INQUIRY");
    await setWorkspaceAgentCapabilities(workspaceId, {
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: false,
    });
    await expect(requireActiveWorkspaceAgent(workspaceId, "BOOK_APPOINTMENT"))
      .rejects.toMatchObject({ code: "AGENT_ACTION_DISABLED" });
    const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId));
    expect(agent.behaviorSettings.voice).toEqual({ profileKey: "ava-us-1" });
    await setWorkspaceAgentStatus(workspaceId, "PAUSED");
    await expect(requireActiveWorkspaceAgent(workspaceId))
      .rejects.toMatchObject({ code: "AGENT_NOT_ACTIVE" });
  });

  it("makes configured business guardrails available in the actual agent conversation", async () => {
    await db.insert(aiAgents).values({
      workspaceId, name: "Mia", status: "ACTIVE",
      behaviorSettings: { guardrails: ["Do not mention a service that is not in the catalog."] },
    });
    const context = await buildAgentTestContext(workspaceId,
      [{ role: "user", content: "What services do you offer?" }]);
    expect(context.agent?.id).toBeTruthy();
    expect(context.systemPrompt).toContain("Do not mention a service that is not in the catalog.");
    expect(context.messages).toEqual([{ role: "user", content: "What services do you offer?" }]);
  });

  it("isolates one workspace policy from another workspace", async () => {
    const [other] = await db.insert(workspaces).values({ name: "Other" }).returning();
    await db.insert(aiAgents).values([
      { workspaceId, name: "Mia", status: "ACTIVE" },
      { workspaceId: other.id, name: "Alex", status: "ACTIVE" },
    ]);
    await setWorkspaceAgentCapabilities(workspaceId, {
      ...defaultAgentCapabilities, BOOK_APPOINTMENT: false,
    });
    await expect(requireActiveWorkspaceAgent(workspaceId, "BOOK_APPOINTMENT"))
      .rejects.toBeInstanceOf(AppError);
    await expect(requireActiveWorkspaceAgent(other.id, "BOOK_APPOINTMENT"))
      .resolves.toMatchObject({ status: "ACTIVE" });
  });
});
