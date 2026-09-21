import { describe, expect, it, vi } from "vitest";
import { createResponseOrchestrator } from "./index";
import { parseOrchestratorEnvelope } from "./tools";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { AppError } from "@/server/http/errors";

function fakeContext(handlingMode: "AI" | "HUMAN" = "AI") {
  return {
    workspaceId: "00000000-0000-0000-0000-000000000001",
    conversation: { handlingMode },
    contact: { id: "00000000-0000-0000-0000-000000000003" },
    agent: null,
    systemPrompt: "You are the assistant.",
    messages: [{ role: "user" as const, content: "Can I book tomorrow?" }],
  };
}

describe("orchestrator response protocol", () => {
  it("falls back to a safe text-only response when provider output is not JSON", () => {
    expect(parseOrchestratorEnvelope("I can help with that.")).toEqual({
      reply: "I can help with that.",
      action: { type: "NONE" },
    });
  });

  it("normalizes null optional fields commonly emitted by JSON planners", () => {
    expect(parseOrchestratorEnvelope(JSON.stringify({
      reply: null,
      contact: null,
      lead: null,
      unresolved: null,
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2030-09-23T08:00:00Z",
        endsAt: "2030-09-23T18:00:00Z",
        timezone: "UTC",
        durationMinutes: null,
      },
    }))).toEqual({
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2030-09-23T08:00:00Z",
        endsAt: "2030-09-23T18:00:00Z",
        timezone: "UTC",
      },
    });
  });

  it("keeps a valid action when optional planner metadata is invalid", () => {
    expect(parseOrchestratorEnvelope(JSON.stringify({
      reply: "Checking that time.",
      lead: { status: "BOOKED", intent: "Office cleaning" },
      contact: { email: "not-an-email" },
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2030-09-23T10:00:00Z",
        endsAt: "2030-09-23T12:00:00Z",
        timezone: "UTC",
        durationMinutes: "30",
      },
    }))).toEqual({
      reply: "Checking that time.",
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2030-09-23T10:00:00Z",
        endsAt: "2030-09-23T12:00:00Z",
        timezone: "UTC",
        durationMinutes: 30,
      },
    });
  });

  it("extracts the first complete JSON object without swallowing trailing model output", () => {
    expect(parseOrchestratorEnvelope(
      '{"reply":"I can help.","action":{"type":"NONE"}}\n{"debug":"ignore me"}',
    )).toEqual({ reply: "I can help.", action: { type: "NONE" } });
  });

  it("rejects malformed or invalid structured actions instead of exposing raw JSON", () => {
    expect(() => parseOrchestratorEnvelope('{"action":{"type":"BOOK_APPOINTMENT"}}')).toThrow("invalid orchestration action");
    expect(() => parseOrchestratorEnvelope(JSON.stringify({
      action: {
        type: "BOOK_APPOINTMENT",
        startsAt: "2026-09-18T11:00:00Z",
        endsAt: "2026-09-18T10:00:00Z",
        timezone: "UTC",
        title: "Consultation",
      },
    }))).toThrow("invalid orchestration action");
    expect(() => parseOrchestratorEnvelope(JSON.stringify({
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2026-09-18T09:00:00Z",
        endsAt: "2026-09-18T17:00:00Z",
        timezone: "Definitely/Not-A-Timezone",
      },
    }))).toThrow("invalid orchestration action");
  });


  it.each(["DRAFT", "PAUSED"] as const)("does not call AI or tools for a %s live agent", async status => {
    const generate = vi.fn();
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("does not invoke AI if answering is disabled, even without installed workflows", async () => {
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ANSWER_INQUIRY: false } } },
      })),
      executeTools: vi.fn(), generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses default agent behavior without a configured workflow", async () => {
    const generate = vi.fn(async () => ({ text: JSON.stringify({ action: { type: "NONE" },
      reply: "We offer the services in our approved business profile." }) }));
    const executeTools = vi.fn(async (
      _workspaceId: string,
      _conversationId: string,
      _contactId: string,
      _envelope: { action: { type: string } },
    ) => ({ kind: "none" as const, data: {} }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools, generate,
    });
    expect((await orchestrator.respond("workspace", "conversation")).reply)
      .toContain("approved business profile");
    expect(executeTools).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("repairs one invalid structured response instead of failing the customer turn", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: null,
        action: { type: "CHECK_AVAILABILITY", startsAt: "not-a-date" },
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: null,
        action: {
          type: "CHECK_AVAILABILITY",
          startsAt: "2030-09-23T08:00:00Z",
          endsAt: "2030-09-23T18:00:00Z",
          timezone: "UTC",
          durationMinutes: 30,
        },
      }) });
    const executeTools = vi.fn(async () => ({ kind: "availability" as const, data: {
      slots: [{ startsAt: "2030-09-23T10:00:00.000Z", endsAt: "2030-09-23T10:30:00.000Z" }],
    } }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()), executeTools, generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.reply).toContain("Available times include");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("keeps the turn alive with a safe clarification when structured repair also fails", async () => {
    const generate = vi.fn(async () => ({ text: '{"action":}' }));
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()), executeTools, generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("restate your request");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("falls back to an authoritative availability check for a fully specified date and time when planner repair fails", async () => {
    const generate = vi.fn(async () => ({ text: '{"action":}' }));
    const executeTools = vi.fn(async (_workspaceId, _conversationId, _contactId, envelope) => {
      expect(envelope.action).toMatchObject({
        type: "CHECK_AVAILABILITY",
        startsAt: "2037-09-23T10:00:00.000Z",
        timezone: "UTC",
        durationMinutes: 60,
      });
      return { kind: "availability" as const, data: {
        timezone: "UTC",
        slots: [{ startsAt: "2037-09-23T10:00:00.000Z", endsAt: "2037-09-23T10:30:00.000Z" }],
      } };
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        timezone: "UTC",
        services: [{ id: "service-office", name: "Office Cleaning", durationMinutes: 60 }],
        messages: [{ role: "user" as const,
          content: "I want to book my office cleaning appointment but first I want to check availability for Wednesday 23 September 2037 at 10:00 AM" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("Available times include");
    expect(result.reply).toContain("10:00 AM");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("replans a returned-to-AI conversation around the latest legitimate request", async () => {
    const executeTools = vi.fn(async (
      _workspaceId: string,
      _conversationId: string,
      _contactId: string,
      _envelope: { action: { type: string } },
    ) => ({ kind: "none" as const, data: {} }));
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: "I'll connect you to the team.",
        unresolved: { reason: "A previous message asked for a person." },
        action: { type: "ESCALATE", reason: "A previous message asked for a person." },
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: "We offer office cleaning and industrial equipment cleaning.",
        action: { type: "NONE" },
      }) });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"),
        source: "INBOUND_TURN" as const,
        resumedAfterHumanHandoff: true,
        messages: [
          { role: "user" as const, content: "I need a human." },
          { role: "assistant" as const, content: "Staff will follow up." },
          { role: "user" as const, content: "What services do you offer?" },
        ],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools, generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result).toMatchObject({ handlingMode: "AI" });
    expect(result.reply).toContain("office cleaning");
    expect(result.reply).not.toContain("connect you");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledOnce();
    expect(executeTools.mock.calls[0][3]).toMatchObject({ action: { type: "NONE" } });
  });

  it("still applies When Unsure when the resumed current request is genuinely unresolved", async () => {
    const executeTools = vi.fn(async (_workspaceId, _conversationId, _contactId, envelope) => {
      expect(envelope.action.type).toBe("ESCALATE");
      return { kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } };
    });
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: "I'll connect you because this thread was handed off before.",
        action: { type: "ESCALATE", reason: "Previous handoff" },
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        reply: "I can't verify that warranty exception from the approved business information.",
        unresolved: { reason: "The current warranty exception needs staff review." },
        action: { type: "NONE" },
      }) });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"),
        source: "INBOUND_TURN" as const,
        resumedAfterHumanHandoff: true,
        messages: [
          { role: "user" as const, content: "I need a human." },
          { role: "assistant" as const, content: "Staff will follow up." },
          { role: "user" as const, content: "Can you approve this warranty exception?" },
        ],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools, generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("warranty exception");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("treats missing booking details as collection, not uncertainty or handoff", async () => {
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const,
          content: "I would like to book an appointment for my office cleaning at 30 North Gould Street" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I need more information.",
        unresolved: { reason: "The appointment date and time are missing." },
        action: { type: "NONE" },
      }) })),
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toBe("I can help with that. What date and time would you prefer?");
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("turns a complete multi-turn booking into an availability check instead of escalating", async () => {
    const executeTools = vi.fn(async (_workspaceId, _conversationId, _contactId, envelope) => {
      expect(envelope.action).toMatchObject({
        type: "CHECK_AVAILABILITY",
        startsAt: "2037-09-23T10:00:00.000Z",
      });
      return {
        kind: "availability" as const,
        data: {
          timezone: "UTC",
          slots: [{
            startsAt: "2037-09-23T10:00:00.000Z",
            endsAt: "2037-09-23T10:30:00.000Z",
          }],
        },
      };
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        timezone: "UTC",
        services: [{ id: "service-1", name: "Office Cleaning", description: null,
          priceText: null, durationMinutes: 30 }],
        messages: [
          { role: "user" as const,
            content: "I would like to book an appointment for my Office Cleaning at 30 North Gould Street." },
          { role: "assistant" as const, content: "What date and time would you prefer?" },
          { role: "user" as const, content: "Wednesday 23rd September 2037 by 10 AM." },
        ],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll ask a person to handle that.",
        unresolved: { reason: "The booking request is incomplete." },
        action: { type: "ESCALATE", reason: "The booking request is incomplete." },
      }) })),
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.toolResult.kind).toBe("availability");
    expect(result.reply).toContain("Available times include");
    expect(result.reply).not.toContain("staff follow-up");
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("returns an authoritative preview instead of executing a staged booking immediately", async () => {
    const executeTools = vi.fn(async () => ({
      kind: "pending_action" as const,
      data: {
        type: "BOOK_APPOINTMENT",
        title: "Office Cleaning",
        startsAt: "2037-09-23T10:00:00.000Z",
        endsAt: "2037-09-23T11:00:00.000Z",
        timezone: "UTC",
        pendingActionId: "pending-1",
      },
    }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        timezone: "UTC",
        messages: [{ role: "user" as const, content: "Book office cleaning September 23 2037 at 10 AM." }],
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        action: {
          type: "BOOK_APPOINTMENT",
          startsAt: "2037-09-23T10:00:00Z",
          endsAt: "2037-09-23T11:00:00Z",
          timezone: "UTC",
          title: "Office Cleaning",
        },
      }) })),
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("Would you like me to book it?");
    expect(result.reply).not.toContain("is booked");
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("commits a stored staged action directly when the customer explicitly confirms it", async () => {
    const generate = vi.fn();
    const executeTools = vi.fn(async () => ({
      kind: "booking" as const,
      data: {
        appointmentId: "appointment-1",
        title: "Office Cleaning",
        startsAt: "2037-09-23T10:00:00.000Z",
        endsAt: "2037-09-23T11:00:00.000Z",
        timezone: "UTC",
        status: "CONFIRMED",
      },
    }));
    const getAwaitingAction = vi.fn(async () => ({
      id: "pending-1",
      workspaceId: "workspace",
      conversationId: "conversation",
      contactId: fakeContext().contact.id,
      type: "BOOK_APPOINTMENT",
      payload: {
        startsAt: "2037-09-23T10:00:00.000Z",
        endsAt: "2037-09-23T11:00:00.000Z",
        timezone: "UTC",
        title: "Office Cleaning",
        serviceId: null,
        notes: "30 North Gould Street",
      },
      payloadHash: "hash",
      status: "AWAITING_CONFIRMATION",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
      failureCode: null,
      result: null,
    }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        messages: [
          { role: "assistant" as const, content: "Office Cleaning on September 23 at 10 AM. Would you like me to book it?" },
          { role: "user" as const, content: "Yes, please." },
        ],
      })),
      executeTools,
      generate,
      getAwaitingAction,
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result).toMatchObject({
      handlingMode: "AI",
      toolResult: { kind: "booking", data: { appointmentId: "appointment-1", status: "CONFIRMED" } },
    });
    expect(result.reply).toContain("is booked for");
    expect(generate).not.toHaveBeenCalled();
    expect(executeTools).toHaveBeenCalledOnce();
    expect(executeTools.mock.calls[0][3]).toMatchObject({
      action: {
        type: "BOOK_APPOINTMENT",
        title: "Office Cleaning",
        notes: "30 North Gould Street",
      },
    });
  });

  it("responds truthfully when a configured capability is revoked during model planning", async () => {
    const generate = vi.fn(async () => ({ text: JSON.stringify({
      reply: "Your appointment is confirmed.",
      action: { type: "BOOK_APPOINTMENT", startsAt: "2026-09-22T10:00:00Z",
        endsAt: "2026-09-22T10:30:00Z", timezone: "UTC", title: "Consultation" },
    }) }));
    const executeTools = vi.fn(async () => {
      throw new AppError("AGENT_ACTION_DISABLED", "Booking is disabled.", 403);
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()), executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("can't book an appointment");
    expect(result.reply).not.toContain("confirmed");
    expect(generate).toHaveBeenCalledOnce();
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("answers normally when disabled metadata fields are supplied by an untrusted model", async () => {
    const executeTools = vi.fn(async () => ({ kind: "none" as const, data: {} }));
    const generate = vi.fn(async (
      _workspaceId: string, _conversationId: string,
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    ) => ({ text: JSON.stringify({
      reply: "Our current consultation is thirty minutes.",
      contact: { name: "Invented person" },
      lead: { status: "QUALIFIED", intent: "Invented interest" },
      action: { type: "NONE" },
    }) }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: {
            ...defaultAgentCapabilities, UPDATE_CONTACT: false,
            UPDATE_LEAD: false, QUALIFY_LEAD: false,
          } } },
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBe("Our current consultation is thirty minutes.");
    expect(executeTools).toHaveBeenCalledWith("workspace", "conversation",
      fakeContext().contact.id,
      expect.objectContaining({ contact: undefined, lead: undefined, action: { type: "NONE" } }));
    expect(String(generate.mock.calls[0]?.[2]?.[0]?.content))
      .not.toContain('"contact": {');
  });

  it("does not invoke AI while a human owns the conversation", async () => {
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("HUMAN")),
      executeTools: vi.fn(),
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("HUMAN");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    "an operator",
    "How can I speak to a human?",
    "I need to talk to a team member",
    "I need to speak to a person.",
  ])("escalates explicit live caller request %s without promising a live transfer", async (utterance) => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST: answer caller.",
      messages: [{ role: "user" as const, content: utterance }],
    };
    const executeTools = vi.fn().mockResolvedValue({
      kind: "escalation", data: { handlingMode: "AI", scope: "ISSUE" },
    });
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context), executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("I can't transfer this call live.");
    expect(executeTools).toHaveBeenCalledWith("workspace", "conversation",
      context.contact.id, { action: {
        type: "ESCALATE", reason: "Caller requested a human during a phone call.",
      } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not promise staff follow-up when phone escalation is disabled", async () => {
    const executeTools = vi.fn();
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: false } } },
        systemPrompt: "LIVE PHONE RECEPTIONIST:",
        messages: [{ role: "user" as const, content: "Can I speak to a human?" }],
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't arrange staff follow-up");
    expect(result.reply).not.toContain("I've flagged");
    expect(executeTools).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not claim staff follow-up if escalation is revoked while a phone turn is in progress", async () => {
    const executeTools = vi.fn(async () => {
      throw new AppError("AGENT_ACTION_DISABLED", "Escalation is disabled.", 403);
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
        systemPrompt: "LIVE PHONE RECEPTIONIST:",
        messages: [{ role: "user" as const, content: "I need to speak to a person." }],
      })),
      executeTools, generate: vi.fn(),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).not.toContain("I've flagged");
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("suppresses a model-only live transfer promise when no transfer or escalation occurred", async () => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST:",
      messages: [{ role: "user" as const, content: "What services do you offer?" }],
    };
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context),
      executeTools: vi.fn(async () => ({ kind: "none" as const, data: {} })),
      generate: vi.fn(async () => ({
        text: JSON.stringify({ reply: "I'll connect you with our team to book office cleaning.", action: { type: "NONE" } }),
      })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("I can't transfer this call live.");
    expect(result.reply).not.toContain("I'll connect");
    expect(result.handlingMode).toBe("AI");
  });

  it("does not perform irreversible tools for an utterance superseded during AI generation", async () => {
    const executeTools = vi.fn();
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({ reply: "I will book your appointment now.", action: { type: "NONE" } }),
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools, generate,
    });
    const beforeTools = vi.fn(async () => false);
    const result = await orchestrator.respond("workspace", "conversation", { beforeTools });
    expect(result.reply).toBeNull();
    expect(executeTools).not.toHaveBeenCalled();
    expect(beforeTools).toHaveBeenCalledTimes(1);
  });

  it("does not escalate after the caller supersedes a human-request fragment", async () => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST:",
      messages: [{ role: "user" as const, content: "an operator" }],
    };
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context),
      executeTools, generate: vi.fn(),
    });
    const result = await orchestrator.respond("workspace", "conversation", {
      beforeTools: async () => false,
    });
    expect(result.reply).toBeNull();
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("uses an authoritative availability result before answering the customer", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: {
            type: "CHECK_AVAILABILITY",
            startsAt: "2026-09-18T09:00:00Z",
            endsAt: "2026-09-18T17:00:00Z",
            timezone: "UTC",
            durationMinutes: 30,
          },
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ reply: "I have a 10:00 AM opening tomorrow.", action: { type: "NONE" } }),
      });
    const executeTools = vi.fn().mockResolvedValue({
      kind: "availability",
      data: { slots: [{ startsAt: "2026-09-18T10:00:00.000Z", endsAt: "2026-09-18T10:30:00.000Z" }] },
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("Sep 18, 2026");
    expect(result.reply).toContain("10:00 AM");
    expect(result.toolResult.kind).toBe("availability");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(executeTools).toHaveBeenCalledTimes(1);
  });

  it("reports actual empty availability rather than inventing a slot", async () => {
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools: vi.fn(async () => ({ kind: "availability" as const, data: { slots: [] } })),
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "You have a 10 AM appointment available.",
        action: { type: "CHECK_AVAILABILITY", startsAt: "2030-09-23T10:00:00Z",
          endsAt: "2030-09-23T14:00:00Z", timezone: "UTC" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("no available slots");
    expect(result.reply).not.toContain("10 AM appointment available");
  });

  it("reports invalid saved calendar settings without failing the customer turn", async () => {
    const executeTools = vi.fn()
      .mockRejectedValueOnce(new AppError(
        "CALENDAR_CONFIG_INVALID",
        "The saved calendar availability settings are invalid. Please save them again.",
        409,
      ))
      .mockResolvedValueOnce({ kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you check September 23 at 10 AM?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        action: { type: "CHECK_AVAILABILITY",
          startsAt: "2030-09-23T10:00:00Z", endsAt: "2030-09-23T11:00:00Z",
          timezone: "UTC", durationMinutes: 30 },
      }) })),
    });

    const result = await orchestrator.respond("workspace", "conversation");

    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("couldn't check live availability");
    expect(result.reply).toContain("saved calendar availability settings are invalid");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(executeTools).toHaveBeenCalledTimes(2);
    expect(executeTools.mock.calls[1][3]).toMatchObject({ action: { type: "ESCALATE" } });
  });

  it("explains disabled availability instead of silently escalating an appointment request", async () => {
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you check available slots for Thursday?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Ask a clarifying question", escalationMessage: null,
          behaviorSettings: { capabilities: {
            ...defaultAgentCapabilities, CHECK_AVAILABILITY: false,
          } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll flag the team", action: { type: "ESCALATE", reason: "No calendar" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't check live appointment availability");
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("truthfully refuses a disabled capability and escalates when When Unsure requires it", async () => {
    const executeTools = vi.fn(async (_workspaceId, _conversationId, _contactId, envelope) => {
      expect(envelope.action.type).toBe("ESCALATE");
      return { kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } };
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you check available slots for Thursday?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: {
            ...defaultAgentCapabilities, CHECK_AVAILABILITY: false, ESCALATE: true,
          } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll ask the team", action: { type: "ESCALATE", reason: "Availability is disabled" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't check live appointment availability");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(executeTools).toHaveBeenCalledTimes(1);
  });

  it("applies When Unsure after the server rejects a now-disabled booking action", async () => {
    const executeTools = vi.fn()
      .mockRejectedValueOnce(new AppError("AGENT_ACTION_DISABLED", "Booking is disabled.", 403))
      .mockResolvedValueOnce({ kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you verify whether this warranty exception is covered?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "Booked.", action: { type: "BOOK_APPOINTMENT",
          startsAt: "2030-09-23T10:00:00Z", endsAt: "2030-09-23T10:30:00Z",
          timezone: "UTC", title: "Consultation" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't book an appointment");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(executeTools).toHaveBeenCalledTimes(2);
    expect(executeTools.mock.calls[1][3]).toMatchObject({ action: { type: "ESCALATE" } });
  });

  it("does not hand off when When Unsure requests escalation but escalation capability is disabled", async () => {
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Check available times Thursday" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: {
            ...defaultAgentCapabilities, CHECK_AVAILABILITY: false, ESCALATE: false,
          } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll hand this to staff", action: { type: "ESCALATE", reason: "Cannot check" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't check live appointment availability");
    expect(result.reply).toContain("can't arrange staff follow-up");
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("uses structured unresolved requests to enforce When Unsure escalation even when the model returns NONE", async () => {
    const executeTools = vi.fn(async (
      _workspaceId: string,
      _conversationId: string,
      _contactId: string,
      envelope: { action: { type: string } },
    ) => {
      expect(envelope.action.type).toBe("ESCALATE");
      return { kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } };
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you verify whether this warranty exception is covered?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I can't verify that request with the information available.",
        unresolved: { reason: "Approved business information is insufficient." },
        action: { type: "NONE" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't verify that request");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(executeTools).toHaveBeenCalledTimes(1);
  });

  it("keeps the conversation with AI when structured unresolved policy says ask a clarifying question", async () => {
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Which location handles this request?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Ask a clarifying question", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I’m not sure which location you mean. Which office should I use?",
        unresolved: { reason: "Location is ambiguous." },
        action: { type: "NONE" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("Which office should I use?");
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("blocks model-proposed handoff when When Unsure says ask a clarifying question", async () => {
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Can you help with our warranty exception?" }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Ask a clarifying question", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll hand this to a person.", action: { type: "ESCALATE", reason: "Unsure" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("clarify");
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("does not apply When Unsure escalation after a realtime turn is superseded", async () => {
    const executeTools = vi.fn();
    const beforeTools = vi.fn(async () => false);
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        messages: [{ role: "user" as const, content: "Please review this warranty exception." }],
        agent: { id: "agent-1", status: "ACTIVE" as const,
          whenUnsure: "Escalate to a human", escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: true } } },
      })),
      executeTools,
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I can't complete that request.",
        unresolved: { reason: "Need staff review." },
        action: { type: "NONE" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation", { beforeTools });
    expect(result.reply).toBeNull();
    expect(result.handlingMode).toBe("AI");
    expect(beforeTools).toHaveBeenCalledTimes(1);
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("does not invent staff notification when the model returns only a promise", async () => {
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()),
      executeTools: vi.fn(async () => ({ kind: "none" as const, data: {} })),
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I'll flag this for the staff to follow up.",
        action: { type: "NONE" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("please ask me to arrange it");
    expect(result.reply).not.toContain("I'll flag");
  });

  it("acknowledges a persisted contact update by the fields that actually changed", async () => {
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()),
      executeTools: vi.fn(async () => ({ kind: "contact" as const,
        data: { contactId: "person", updatedFields: ["phone"] } })),
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "Thanks", contact: { phone: "+13074453684" }, action: { type: "NONE" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("updated your contact details (phone)");
    expect(result.reply).toContain("Thanks");
  });

  it("acknowledges only successful staff escalation, not model-only promises", async () => {
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(),
        messages: [{ role: "user" as const, content: "I want to speak to a human." }],
      })),
      executeTools: vi.fn(async () => ({ kind: "escalation" as const, data: { handlingMode: "AI", scope: "ISSUE" } })),
      generate: vi.fn(async () => ({ text: JSON.stringify({
        reply: "I can connect you live.", action: { type: "ESCALATE", reason: "Requested" },
      }) })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("flagged this issue for staff follow-up");
    expect(result.reply).not.toContain("connect you live");
  });

  it("confirms a persisted booking without another unreliable AI finalizer", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: {
            type: "BOOK_APPOINTMENT",
            startsAt: "2026-09-18T10:00:00Z",
            endsAt: "2026-09-18T10:30:00Z",
            timezone: "UTC",
            title: "Consultation",
          },
        }),
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const executeTools = vi.fn().mockResolvedValue({
      kind: "booking",
      data: {
        appointmentId: "appointment-1",
        title: "Consultation",
        startsAt: "2026-09-18T10:00:00.000Z",
        endsAt: "2026-09-18T10:30:00.000Z",
        timezone: "UTC",
        status: "CONFIRMED",
      },
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.toolResult.kind).toBe("booking");
    expect(result.reply).toContain("Consultation is booked");
    expect(result.reply).toContain("UTC");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
