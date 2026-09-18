"use client";

import { useId, useState } from "react";

export type QualificationCriterion = {
  id: string;
  label: string;
  question: string;
  required: boolean;
};

type QualificationConfig = {
  enabled: boolean;
  criteria: QualificationCriterion[];
};

const fallbackCriteria: QualificationCriterion[] = [
  { id: "service_needed", label: "Service needed", question: "What service are you looking for?", required: true },
  { id: "location", label: "Location", question: "What city or ZIP code is the service for?", required: true },
  { id: "urgency", label: "Urgency", question: "How soon do you need help?", required: true },
];

function nextId(criteria: QualificationCriterion[]) {
  const used = new Set(criteria.map((item) => item.id));
  let index = criteria.length + 1;
  while (used.has(`question_${index}`)) index += 1;
  return `question_${index}`;
}

export function QualificationEditor({ initial }: { initial?: Partial<QualificationConfig> | null }) {
  const helpId = useId();
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [criteria, setCriteria] = useState<QualificationCriterion[]>(
    initial?.criteria?.length ? initial.criteria : fallbackCriteria,
  );

  const update = (index: number, patch: Partial<QualificationCriterion>) => {
    setCriteria((current) => current.map((criterion, position) =>
      position === index ? { ...criterion, ...patch } : criterion,
    ));
  };

  const serialized = JSON.stringify({ enabled, criteria });

  return (
    <div className="qualificationEditor">
      <input type="hidden" name="qualificationConfig" value={serialized} />
      <div className="qualificationToggleRow">
        <div>
          <strong>Qualify incoming leads</strong>
          <span id={helpId}>Collect these answers naturally across web chat, SMS, WhatsApp and phone calls.</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            aria-describedby={helpId}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span />
        </label>
      </div>

      {enabled && (
        <div className="qualificationCriteria">
          {criteria.map((criterion, index) => (
            <div className="qualificationCriterion" key={criterion.id}>
              <div className="qualificationCriterionFields">
                <label className="aiField">
                  <span>Field</span>
                  <input
                    value={criterion.label}
                    maxLength={120}
                    onChange={(event) => update(index, { label: event.target.value })}
                  />
                </label>
                <label className="aiField qualificationQuestion">
                  <span>Question</span>
                  <input
                    value={criterion.question}
                    maxLength={300}
                    onChange={(event) => update(index, { question: event.target.value })}
                  />
                </label>
              </div>
              <label className="qualificationRequired">
                <input
                  type="checkbox"
                  checked={criterion.required}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                Required
              </label>
              <button
                type="button"
                className="qualificationRemove"
                aria-label={`Remove ${criterion.label || "qualification question"}`}
                disabled={criteria.length <= 1}
                onClick={() => setCriteria((current) => current.filter((_, position) => position !== index))}
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="qualificationAdd"
            disabled={criteria.length >= 10}
            onClick={() => setCriteria((current) => [
              ...current,
              { id: nextId(current), label: "New field", question: "What would you like to ask?", required: false },
            ])}
          >
            ＋ Add qualification question
          </button>
        </div>
      )}
    </div>
  );
}
