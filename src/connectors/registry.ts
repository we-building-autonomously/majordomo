import type { Connector } from "../types.ts";
import { supabaseConnector } from "./supabase.ts";
import { twilioConnector } from "./twilio.ts";
import { browserbaseConnector } from "./browserbase.ts";
import { agenticConnector } from "./agentic.ts";

// Bespoke connectors are OPTIONAL accelerators the harness ships with. Everything
// else — including any service the user adds free-form — flows through the single
// universal `agenticConnector`. Set MAJORDOMO_GENERIC=1 to force the universal path
// even for services that have a bespoke accelerator.
const BESPOKE: Record<string, Connector> = {
  supabase: supabaseConnector,
  twilio: twilioConnector,
  browserbase: browserbaseConnector,
};

export function getConnector(catalogKey: string): Connector {
  if (process.env.MAJORDOMO_GENERIC === "1") return agenticConnector;
  return BESPOKE[catalogKey] ?? agenticConnector;
}
