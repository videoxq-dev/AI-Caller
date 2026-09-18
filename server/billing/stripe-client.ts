import Stripe from "stripe";
import { getEnv } from "@/server/env";

let client: Stripe | undefined;

export function getStripeClient() {
  if (client) return client;
  const key = getEnv().STRIPE_RESTRICTED_API_KEY;
  if (!key) throw new Error("Stripe billing is not configured on the server.");
  client = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  return client;
}

export function resetStripeClientForTests() {
  client = undefined;
}
