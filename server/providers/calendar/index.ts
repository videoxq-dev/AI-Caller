import type { CalendarProvider } from "../contracts";
import type { CalendarInput } from "./helpers";
import { GoogleCalendarProvider } from "./google";
import { OutlookCalendarProvider } from "./outlook";
import { CalendlyCalendarProvider } from "./calendly";
import { CalComCalendarProvider } from "./calcom";

export function createCalendarProvider(input: CalendarInput, fetcher: typeof fetch = fetch): CalendarProvider {
  switch (input.provider) {
    case "google": return new GoogleCalendarProvider(input, fetcher);
    case "outlook": return new OutlookCalendarProvider(input, fetcher);
    case "calendly": return new CalendlyCalendarProvider(input, fetcher);
    case "calcom": return new CalComCalendarProvider(input, fetcher);
    default: throw new Error(`Calendar operations are not supported by provider ${input.provider}.`);
  }
}

export { slotize } from "./helpers";
