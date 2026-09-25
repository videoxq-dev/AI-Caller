"use client";

import type { AgencyTemplateSnapshot } from "@/server/agency/template-schema";

type Agent = AgencyTemplateSnapshot["agent"];
type Business = AgencyTemplateSnapshot["business"];

export function blankAgencyTemplate(): AgencyTemplateSnapshot {
  return {
    schemaVersion: 1,
    business: { industry: null, summary: null, timezone: "UTC", hours: [] },
    agent: {
      name: "Mia", tone: "Friendly and professional", primaryGoal: "Answer customer inquiries",
      whenUnsure: "Escalate to a human",
      advancedInstructions: null, openingMessage: "Hello from {{business_name}}. How can I help?",
      escalationMessage: null, guardrails: [],
      voice: {
        profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
        recordingPolicy: "ANNOUNCE", afterHoursEnabled: true,
      },
      qualification: { enabled: false, criteria: [] },
    },
    services: [], faqs: [], policies: [], recipes: [],
  };
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function AgencyTemplateEditor({
  value, onChange,
}: {
  value: AgencyTemplateSnapshot;
  onChange: (next: AgencyTemplateSnapshot) => void;
}) {
  const setBusiness = (next: Partial<Business>) => onChange({
    ...value, business: { ...value.business, ...next },
  });
  const setAgent = (next: Partial<Agent>) => onChange({
    ...value, agent: { ...value.agent, ...next },
  });

  return (
    <div className="agencyTemplateEditor">
      <fieldset className="agencyTemplateSection">
        <legend>Reusable business details</legend>
        <p>Leave client-specific addresses, phone numbers and websites out. Use {"{{business_name}}"} in reusable wording.</p>
        <div className="agencyTemplateFields">
          <label>Industry
            <input maxLength={120} value={value.business.industry ?? ""}
              onChange={(event) => setBusiness({ industry: event.target.value || null })} />
          </label>
          <label>Timezone
            <input required maxLength={120} value={value.business.timezone}
              onChange={(event) => setBusiness({ timezone: event.target.value })} />
          </label>
          <label className="agencyTemplateWide">Business summary
            <textarea maxLength={4000} rows={3} value={value.business.summary ?? ""}
              onChange={(event) => setBusiness({ summary: event.target.value || null })} />
          </label>
        </div>
        <details>
          <summary>Proposed business hours ({value.business.hours.length}/7 days)</summary>
          <p>These hours are proposals. Check each client's real schedule before going live.</p>
          {weekdays.map((label, dayOfWeek) => {
            const hour = value.business.hours.find((item) => item.dayOfWeek === dayOfWeek);
            const update = (patch: Partial<NonNullable<typeof hour>>) => {
              const updated = { dayOfWeek, enabled: false, openTime: null, closeTime: null, ...hour, ...patch };
              setBusiness({
                hours: [...value.business.hours.filter((item) => item.dayOfWeek !== dayOfWeek), updated]
                  .sort((left, right) => left.dayOfWeek - right.dayOfWeek),
              });
            };
            return (
              <div className="agencyTemplateHours" key={dayOfWeek}>
                <label><input type="checkbox" checked={hour?.enabled ?? false}
                  onChange={(event) => update({
                    enabled: event.target.checked,
                    openTime: event.target.checked ? (hour?.openTime ?? "09:00") : null,
                    closeTime: event.target.checked ? (hour?.closeTime ?? "17:00") : null,
                  })} />{label}</label>
                <input aria-label={`${label} opens`} type="time" disabled={!hour?.enabled}
                  value={hour?.openTime ?? ""} onChange={(event) => update({ openTime: event.target.value })} />
                <input aria-label={`${label} closes`} type="time" disabled={!hour?.enabled}
                  value={hour?.closeTime ?? ""} onChange={(event) => update({ closeTime: event.target.value })} />
              </div>
            );
          })}
        </details>
      </fieldset>

      <fieldset className="agencyTemplateSection">
        <legend>AI receptionist</legend>
        <p>Only reusable conversational settings are saved. The new agent always starts as a draft with operational actions disabled.</p>
        <div className="agencyTemplateFields">
          {([
            ["name", "Agent name", 100],
            ["tone", "Tone", 120],
            ["primaryGoal", "Primary goal", 160],
            ["whenUnsure", "When unsure", 160],
          ] as const).map(([key, label, maxLength]) => (
            <label key={key}>{label}
              <input required maxLength={maxLength} value={value.agent[key]}
                onChange={(event) => setAgent({ [key]: event.target.value })} />
            </label>
          ))}
          {([
            ["openingMessage", "Opening greeting", 2000],
            ["escalationMessage", "Escalation message", 2000],
            ["advancedInstructions", "Advanced instructions", 8000],
          ] as const).map(([key, label, maxLength]) => (
            <label className="agencyTemplateWide" key={key}>{label}
              <textarea rows={3} maxLength={maxLength} value={value.agent[key] ?? ""}
                onChange={(event) => setAgent({ [key]: event.target.value || null })} />
            </label>
          ))}
          <label>Voice profile
            <input required maxLength={100} value={value.agent.voice.profileKey}
              onChange={(event) => setAgent({
                voice: { ...value.agent.voice, profileKey: event.target.value },
              })} />
          </label>
          <label>Language
            <input required maxLength={20} value={value.agent.voice.language}
              onChange={(event) => setAgent({
                voice: { ...value.agent.voice, language: event.target.value },
              })} />
          </label>
          <label>Speaking rate (0.75–1.25)
            <input type="number" step={0.05} min={0.75} max={1.25} required
              value={value.agent.voice.speakingRate} onChange={(event) => setAgent({
                voice: { ...value.agent.voice, speakingRate: Number(event.target.value) },
              })} />
          </label>
          <label>Recording notice
            <select value={value.agent.voice.recordingPolicy} onChange={(event) => setAgent({
              voice: { ...value.agent.voice, recordingPolicy: event.target.value as Agent["voice"]["recordingPolicy"] },
            })}>
              <option value="ANNOUNCE">Announce recording</option>
              <option value="EXPLICIT_CONSENT">Obtain explicit consent</option>
            </select>
          </label>
        </div>
        <label className="agencyTemplateCheckbox"><input type="checkbox"
          checked={value.agent.voice.afterHoursEnabled}
          onChange={(event) => setAgent({ voice: {
            ...value.agent.voice, afterHoursEnabled: event.target.checked,
          } })} /> Propose after-hours answering</label>
        <label className="agencyTemplateCheckbox"><input type="checkbox"
          checked={value.agent.qualification.enabled}
          onChange={(event) => setAgent({ qualification: {
            ...value.agent.qualification, enabled: event.target.checked,
          } })} /> Enable lead qualification</label>
        <details>
          <summary>Guardrails ({value.agent.guardrails.length})</summary>
          {value.agent.guardrails.map((rule, index) => (
            <div className="agencyTemplateInline" key={index}>
              <input aria-label={`Guardrail ${index + 1}`} maxLength={500} value={rule}
                onChange={(event) => setAgent({
                  guardrails: value.agent.guardrails.map((item, i) => i === index ? event.target.value : item),
                })} />
              <button type="button" className="agencySecondaryButton" onClick={() => setAgent({
                guardrails: value.agent.guardrails.filter((_, i) => i !== index),
              })}>Remove</button>
            </div>
          ))}
          <button type="button" className="agencySecondaryButton"
            disabled={value.agent.guardrails.length >= 30}
            onClick={() => setAgent({ guardrails: [...value.agent.guardrails, ""] })}>+ Guardrail</button>
        </details>
        <details>
          <summary>Qualification questions ({value.agent.qualification.criteria.length})</summary>
          {value.agent.qualification.criteria.map((criterion, index) => (
            <div className="agencyTemplateEntry" key={index}>
              <label>Identifier
                <input required maxLength={64} value={criterion.id} onChange={(event) => setAgent({
                  qualification: { ...value.agent.qualification,
                    criteria: value.agent.qualification.criteria.map((item, i) => i === index
                      ? { ...item, id: event.target.value } : item) },
                })} />
              </label>
              <label>Label
                <input required maxLength={120} value={criterion.label} onChange={(event) => setAgent({
                  qualification: { ...value.agent.qualification,
                    criteria: value.agent.qualification.criteria.map((item, i) => i === index
                      ? { ...item, label: event.target.value } : item) },
                })} />
              </label>
              <label>Question
                <textarea required rows={2} maxLength={300} value={criterion.question}
                  onChange={(event) => setAgent({ qualification: { ...value.agent.qualification,
                    criteria: value.agent.qualification.criteria.map((item, i) => i === index
                      ? { ...item, question: event.target.value } : item) },
                  })} />
              </label>
              <label className="agencyTemplateCheckbox"><input type="checkbox" checked={criterion.required}
                onChange={(event) => setAgent({ qualification: { ...value.agent.qualification,
                  criteria: value.agent.qualification.criteria.map((item, i) => i === index
                    ? { ...item, required: event.target.checked } : item) },
                })} /> Required</label>
              <button type="button" className="agencySecondaryButton" onClick={() => setAgent({
                qualification: { ...value.agent.qualification,
                  criteria: value.agent.qualification.criteria.filter((_, i) => i !== index) },
              })}>Remove question</button>
            </div>
          ))}
          <button type="button" className="agencySecondaryButton"
            disabled={value.agent.qualification.criteria.length >= 10}
            onClick={() => setAgent({
              qualification: { ...value.agent.qualification, criteria: [
                ...value.agent.qualification.criteria, { id: `question_${value.agent.qualification.criteria.length + 1}`,
                  label: "Qualification", question: "What do you need help with?", required: true },
              ] },
            })}>+ Qualification question</button>
        </details>
      </fieldset>

      <fieldset className="agencyTemplateSection">
        <legend>Service catalogue ({value.services.length})</legend>
        {value.services.map((service, index) => (
          <div className="agencyTemplateEntry" key={index}>
            <label>Service name
              <input required maxLength={160} value={service.name}
                onChange={(event) => onChange({ ...value, services: value.services.map((item, i) =>
                  i === index ? { ...item, name: event.target.value } : item) })} />
            </label>
            <label>Description
              <textarea rows={2} maxLength={3000} value={service.description ?? ""}
                onChange={(event) => onChange({ ...value, services: value.services.map((item, i) =>
                  i === index ? { ...item, description: event.target.value || null } : item) })} />
            </label>
            <label>Proposed price
              <input maxLength={160} value={service.priceText ?? ""}
                onChange={(event) => onChange({ ...value, services: value.services.map((item, i) =>
                  i === index ? { ...item, priceText: event.target.value || null } : item) })} />
            </label>
            <label>Duration in minutes
              <input type="number" min={1} max={1440} value={service.durationMinutes ?? ""}
                onChange={(event) => onChange({ ...value, services: value.services.map((item, i) =>
                  i === index ? { ...item, durationMinutes: event.target.value ? Number(event.target.value) : null } : item) })} />
            </label>
            <label className="agencyTemplateCheckbox"><input type="checkbox" checked={service.active}
              onChange={(event) => onChange({ ...value, services: value.services.map((item, i) =>
                i === index ? { ...item, active: event.target.checked } : item) })} /> Available in proposed catalogue</label>
            <button type="button" className="agencySecondaryButton"
              onClick={() => onChange({ ...value, services: value.services.filter((_, i) => i !== index) })}>
              Remove service</button>
          </div>
        ))}
        <button type="button" className="agencySecondaryButton" disabled={value.services.length >= 100}
          onClick={() => onChange({ ...value, services: [...value.services,
            { name: "", description: null, priceText: null, durationMinutes: null, active: true }] })}>
          + Service</button>
      </fieldset>

      <fieldset className="agencyTemplateSection">
        <legend>Frequently asked questions ({value.faqs.length})</legend>
        {value.faqs.map((faq, index) => (
          <div className="agencyTemplateEntry" key={index}>
            <label>Question<input required maxLength={1000} value={faq.question}
              onChange={(event) => onChange({ ...value, faqs: value.faqs.map((item, i) =>
                i === index ? { ...item, question: event.target.value } : item) })} /></label>
            <label>Answer<textarea required rows={3} maxLength={5000} value={faq.answer}
              onChange={(event) => onChange({ ...value, faqs: value.faqs.map((item, i) =>
                i === index ? { ...item, answer: event.target.value } : item) })} /></label>
            <label className="agencyTemplateCheckbox"><input type="checkbox" checked={faq.active}
              onChange={(event) => onChange({ ...value, faqs: value.faqs.map((item, i) =>
                i === index ? { ...item, active: event.target.checked } : item) })} /> Enabled in proposed catalogue</label>
            <button type="button" className="agencySecondaryButton"
              onClick={() => onChange({ ...value, faqs: value.faqs.filter((_, i) => i !== index) })}>Remove FAQ</button>
          </div>
        ))}
        <button type="button" className="agencySecondaryButton" disabled={value.faqs.length >= 100}
          onClick={() => onChange({ ...value, faqs: [...value.faqs, { question: "", answer: "", active: true }] })}>
          + FAQ</button>
      </fieldset>

      <fieldset className="agencyTemplateSection">
        <legend>Reusable policies ({value.policies.length})</legend>
        {value.policies.map((policy, index) => (
          <div className="agencyTemplateEntry" key={index}>
            <label>Policy category<input required maxLength={100} value={policy.type}
              onChange={(event) => onChange({ ...value, policies: value.policies.map((item, i) =>
                i === index ? { ...item, type: event.target.value } : item) })} /></label>
            <label>Policy title<input required maxLength={240} value={policy.title}
              onChange={(event) => onChange({ ...value, policies: value.policies.map((item, i) =>
                i === index ? { ...item, title: event.target.value } : item) })} /></label>
            <label>Approved wording<textarea required rows={3} maxLength={10000} value={policy.content}
              onChange={(event) => onChange({ ...value, policies: value.policies.map((item, i) =>
                i === index ? { ...item, content: event.target.value } : item) })} /></label>
            <button type="button" className="agencySecondaryButton"
              onClick={() => onChange({ ...value, policies: value.policies.filter((_, i) => i !== index) })}>Remove policy</button>
          </div>
        ))}
        <button type="button" className="agencySecondaryButton" disabled={value.policies.length >= 50}
          onClick={() => onChange({ ...value, policies: [...value.policies,
            { type: "GENERAL", title: "", content: "" }] })}>+ Policy</button>
      </fieldset>
      <fieldset className="agencyTemplateSection">
        <legend>Core automation recipes ({value.recipes.length})</legend>
        <p>These recipe settings are reusable proposals only. Every recipe starts disabled in the new client's workspace.</p>
        {value.recipes.length === 0 && <p>No built-in recipes included.</p>}
        {value.recipes.map((recipe, index) => (
          <div className="agencyTemplateEntry" key={recipe.key}>
            <strong>{recipe.key.replaceAll("_", " ")}</strong>
            {"message" in recipe.config && typeof recipe.config.message === "string" && (
              <label>Message
                <textarea rows={3} maxLength={2000} value={recipe.config.message}
                  onChange={(event) => onChange({ ...value, recipes: value.recipes.map((item, i) =>
                    i === index ? { ...item, config: { ...item.config, message: event.target.value } } : item) })} />
              </label>
            )}
            {"delayMinutes" in recipe.config && (
              <label>Delay (minutes)
                <input type="number" min={5} max={1440} value={Number(recipe.config.delayMinutes)}
                  onChange={(event) => onChange({ ...value, recipes: value.recipes.map((item, i) =>
                    i === index ? { ...item, config: { ...item.config, delayMinutes: Number(event.target.value) } } : item) })} />
              </label>
            )}
            {"firstMinutesBefore" in recipe.config && (
              <label>First reminder (minutes before)
                <input type="number" min={15} max={43200} value={Number(recipe.config.firstMinutesBefore)}
                  onChange={(event) => onChange({ ...value, recipes: value.recipes.map((item, i) =>
                    i === index ? { ...item, config: { ...item.config, firstMinutesBefore: Number(event.target.value) } } : item) })} />
              </label>
            )}
            {"secondMinutesBefore" in recipe.config && (
              <label>Second reminder (minutes before, optional)
                <input type="number" min={15} max={43200} value={recipe.config.secondMinutesBefore === null
                  ? "" : Number(recipe.config.secondMinutesBefore)}
                  onChange={(event) => onChange({ ...value, recipes: value.recipes.map((item, i) =>
                    i === index ? { ...item, config: { ...item.config,
                      secondMinutesBefore: event.target.value ? Number(event.target.value) : null } } : item) })} />
              </label>
            )}
            {"notifyInApp" in recipe.config && (
              <label className="agencyTemplateCheckbox"><input type="checkbox" checked={Boolean(recipe.config.notifyInApp)}
                onChange={(event) => onChange({ ...value, recipes: value.recipes.map((item, i) =>
                  i === index ? { ...item, config: { ...item.config, notifyInApp: event.target.checked } } : item) })} /> Notify in app</label>
            )}
            <button type="button" className="agencySecondaryButton"
              onClick={() => onChange({ ...value, recipes: value.recipes.filter((_, i) => i !== index) })}>Remove recipe</button>
          </div>
        ))}
        <p>To add a new built-in recipe, configure it in an existing source workspace and extract a new template preview.</p>
      </fieldset>
    </div>
  );
}
