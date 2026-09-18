"use client";

import { useMemo, useState } from "react";

const INDUSTRIES = [
  "Auto Repair",
  "Plumbing",
  "HVAC",
  "Roofing",
  "Dental",
  "Med Spa",
  "Cleaning",
] as const;

export function IndustryField({ initialIndustry }: { initialIndustry: string | null | undefined }) {
  const initial = initialIndustry?.trim() || "";
  const isKnown = useMemo(() => INDUSTRIES.some((industry) => industry === initial), [initial]);
  const [preset, setPreset] = useState(isKnown ? initial : "Other");
  const [custom, setCustom] = useState(isKnown ? "" : initial);

  return (
    <div className="businessField industryField">
      <span>Industry</span>
      <select value={preset} onChange={(event) => setPreset(event.target.value)} aria-label="Industry category">
        {INDUSTRIES.map((industry) => <option key={industry} value={industry}>{industry}</option>)}
        <option value="Other">Other</option>
      </select>
      {preset === "Other" ? (
        <input
          name="industry"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Enter your industry"
          maxLength={120}
          required
          aria-label="Your industry"
        />
      ) : <input type="hidden" name="industry" value={preset} />}
    </div>
  );
}
