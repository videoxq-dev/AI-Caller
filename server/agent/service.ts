import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiAgents, setupProgress } from "@/db/schema";
import { AppError } from "@/server/http/errors";
import {
  agentCapabilitiesSchema, assertAgentActionAllowed,
  capabilitiesFromBehaviorSettings, type AgentCapability, type AgentCapabilities,
} from "./capabilities";

export async function getWorkspaceAgent(workspaceId: string) {
  const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId)).limit(1);
  return agent ?? null;
}

export async function getAgentPolicySnapshot(workspaceId: string) {
  const agent = await getWorkspaceAgent(workspaceId);
  if (!agent) throw new AppError("AGENT_NOT_CONFIGURED", "Configure your AI Agent first.", 409);
  return {
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    status: agent.status,
    capabilities: capabilitiesFromBehaviorSettings(agent.behaviorSettings),
  };
}

export async function requireActiveWorkspaceAgent(workspaceId: string, capability?: AgentCapability) {
  const policy = await getAgentPolicySnapshot(workspaceId);
  if (policy.status !== "ACTIVE") {
    throw new AppError("AGENT_NOT_ACTIVE", "Activate the AI Agent to handle live conversations.", 409);
  }
  if (capability) assertAgentActionAllowed(policy.capabilities, capability);
  return policy;
}

export async function setWorkspaceAgentStatus(
  workspaceId: string, status: "DRAFT" | "ACTIVE" | "PAUSED",
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [agent] = await tx.update(aiAgents)
      .set({ status, updatedAt: now })
      .where(eq(aiAgents.workspaceId, workspaceId)).returning();
    if (!agent) throw new AppError("AGENT_NOT_CONFIGURED", "Configure your AI Agent first.", 409);
    if (status === "ACTIVE") {
      // The Go Live button must never report an error after actually activating
      // the agent just because the progress write failed in a separate query.
      await tx.insert(setupProgress)
        .values({ workspaceId, liveCompletedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: setupProgress.workspaceId,
          set: { liveCompletedAt: now, updatedAt: now },
        });
    }
    return agent;
  });
}

export async function setWorkspaceAgentCapabilities(workspaceId: string, requested: AgentCapabilities) {
  const capabilities = agentCapabilitiesSchema.parse(requested);
  // Atomic JSONB update retains voice, guardrails and qualification even if edited in another request.
  const [agent] = await db.update(aiAgents).set({
    behaviorSettings: sql`jsonb_set(coalesce(${aiAgents.behaviorSettings}, '{}'::jsonb), '{capabilities}', ${JSON.stringify(capabilities)}::jsonb, true)`,
    updatedAt: new Date(),
  }).where(eq(aiAgents.workspaceId, workspaceId)).returning();
  if (!agent) throw new AppError("AGENT_NOT_CONFIGURED", "Configure your AI Agent first.", 409);
  return agent;
}
