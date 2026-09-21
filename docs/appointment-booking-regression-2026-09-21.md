# Chat and call appointment booking regression

## Findings

The supplied chat screenshots, server logs, and locally transcribed call identify several application defects:

- **Malformed planner output became customer text.** `extractJson` returns `null` for an unclosed JSON object. The parser treated that result as plain prose and returned `action: NONE`. This exposed the internal envelope and discarded its intended booking action, so the apparent preview was never necessarily staged. A misplaced `action` inside optional metadata could also be stripped silently.
- **Explicit approvals were rejected.** The shared commit gate accepted `confirm` but neither `approved` (the chat response) nor `confirmed` (the recorded call response). Voice had a second, different confirmation expression that also rejected `confirmed`. A pending preview could therefore repeat instead of committing.
- **Recovery replayed old availability requests.** The fallback assembled earlier customer messages even when the latest message was an approval or objection. The logs contain three corresponding “Replacing unresolved booking plan with authoritative availability check” events. Recovery also used the business timezone even after the customer supplied UTC.
- **Realtime calls inherited unfinished chat history.** The call transcript contains a request for September 22 followed by a September 23 preview, matching the earlier chat date. The code injected the same contact's previous chat turns into the call. This is consistent with stale history influencing the response, although the supplied logs do not contain the original tool arguments.
- **Voice collection requirements were not explicit.** Availability tools require captured booking state, but the call instructions did not specify the prerequisite capture tool. They also did not clearly distinguish awaiting confirmation from a configuration error.

The September 23 “already passed” statement is inconsistent with the September 21 server timestamps. The evidence does not establish a calendar date-validation failure; it shows an unsupported model statement. Native scheduling already supports booking without Google OAuth or any external calendar, provided business hours are configured.

## Changes

- Reject incomplete, misplaced, and nested orchestration JSON and use the existing bounded repair attempt. Never send raw protocol to a customer.
- Accept explicit `approved`, `confirmed`, and related exact approval phrases through the same checker in chat and voice. Keep rejections and corrections excluded.
- Commit a stored pending action directly on approval, without asking the model to rediscover the selected date. Supply pending state to the planner on other turns.
- Restrict availability recovery to current timing collection, preserve an explicit timezone, and prevent replaying a completed lookup after slot selection.
- Scope realtime transcript context to the current call while retaining saved business/contact facts. Make the capture → availability → preview → approval → booking sequence explicit, including service durations and timezone defaults.
- Recheck capability policy before staging realtime actions and prevent arguments from overriding the named tool's action type.
- Log realtime tool name, result kind, success, and application error code without logging arguments or customer details.

Tool instructions were checked against the [official OpenAI realtime prompting guidance](https://developers.openai.com/api/docs/guides/voice-prompting).

## Verification and rollout

Regression coverage exercises actual PostgreSQL appointment persistence with scripted planner responses and real application tools. It includes malformed chat JSON followed by successful repair and `approved`, voice `Confirmed`/`approved`, repeat invocation without duplicate appointments, corrected dates, timezone recovery, and isolation from earlier chat history. No live AI, carrier, or external calendar calls are made by these regression cases.

Deploy the changed application code to **web, worker, and voice gateway** together using the existing deployment process. This change requires no schema migration or new environment variables. Google OAuth credentials are needed only when connecting Google Calendar.

After deployment, use a new chat and a new call to request a future appointment, choose the offered time, approve the preview, and verify one confirmed appointment in the app. For calls, confirm that the readback preserves the date spoken during that call. The new realtime tool outcome logs make any remaining configuration or tool failure distinguishable from a model statement. Production deployment and live provider verification are separate from the local regression checks.
