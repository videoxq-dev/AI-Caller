"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FlaskIcon,
  LockIcon,
  PhoneIcon,
  RocketIcon,
  SparkleIcon,
  StoreIcon,
} from "@/components/icons";

export type SetupStatus = {
  completedCount: number;
  percent: number;
  steps: {
    business: boolean;
    ai: boolean;
    communication: boolean;
    calendar: boolean;
    test: boolean;
    live: boolean;
  };
};

type StepKey = keyof SetupStatus["steps"];

type Step = {
  key: StepKey;
  number: number;
  title: string;
  description: string;
  tone: "blue" | "purple" | "green" | "orange";
  icon: ReactNode;
};

const steps: Step[] = [
  { key: "business", number: 1, title: "Add your business", description: "Business details, hours and service area", tone: "blue", icon: <StoreIcon size={20} /> },
  { key: "ai", number: 2, title: "Teach your AI", description: "Services, FAQs and policies", tone: "purple", icon: <SparkleIcon size={20} /> },
  { key: "communication", number: 3, title: "Connect communication", description: "Phone, SMS, WhatsApp and web chat", tone: "green", icon: <PhoneIcon size={20} /> },
  { key: "calendar", number: 4, title: "Connect your calendar", description: "Google, Outlook, Calendly or Cal.com", tone: "orange", icon: <CalendarIcon size={20} /> },
  { key: "test", number: 5, title: "Test your AI", description: "Run a chat or call test before going live", tone: "purple", icon: <FlaskIcon size={20} /> },
  { key: "live", number: 6, title: "Go live", description: "Activate your assistant and start handling inquiries", tone: "blue", icon: <RocketIcon size={20} /> },
];

const emptyStatus: SetupStatus = {
  completedCount: 0,
  percent: 0,
  steps: { business: false, ai: false, communication: false, calendar: false, test: false, live: false },
};

export function SetupProgressPanel({
  currentStep,
  estimated = "7 minutes",
  initialStatus,
  className = "sidebarCard",
  progressClassName = "sidebarProgressBar",
}: {
  currentStep: number;
  estimated?: string;
  initialStatus?: SetupStatus;
  className?: string;
  progressClassName?: string;
}) {
  const [status, setStatus] = useState<SetupStatus>(initialStatus ?? emptyStatus);

  useEffect(() => {
    if (initialStatus) return;
    let active = true;
    fetch("/api/setup/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load setup status")))
      .then((payload) => { if (active && payload?.setup) setStatus(payload.setup as SetupStatus); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [initialStatus]);

  const firstIncomplete = useMemo(() => steps.find((step) => !status.steps[step.key])?.number ?? 6, [status]);

  return (
    <section className={className}>
      <div className="sidebarProgressTop"><h2>Setup progress</h2><span>Estimated setup time: {estimated}</span></div>
      <div className={progressClassName}><span style={{ width: `${status.percent}%` }} /></div>
      <div className="sidebarProgressMeta"><span>{status.completedCount} of 6 completed</span><strong>{status.percent}%</strong></div>
      <div className="sidebarSteps">
        {steps.map((step) => {
          const complete = status.steps[step.key];
          const active = !complete && step.number === currentStep;
          const available = !complete && (step.number === firstIncomplete || step.number <= currentStep);
          const locked = !complete && !active && !available;
          const state = complete ? "complete" : active ? "active" : locked ? "locked" : "active";
          return (
            <div className={`sidebarStep ${state}`} key={step.key}>
              <span className="sidebarStepNumber">{step.number}</span>
              <span className={`sidebarStepIcon ${step.tone}`}>{complete ? <CheckIcon size={20} /> : step.icon}</span>
              <div><strong>{step.title}</strong><span>{step.description}</span></div>
              {locked ? <LockIcon size={15} /> : <ChevronRightIcon size={18} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
