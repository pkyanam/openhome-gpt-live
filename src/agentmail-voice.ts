import { createHash } from "node:crypto";
import type { AgentMailClient } from "./agentmail-client.ts";
import type { AgentMailComposeDecision } from "./agentmail-composer.ts";

export async function executeAgentMailVoiceRequest(options: {
  transcript: string;
  client: AgentMailClient;
  compose: (transcript: string) => Promise<AgentMailComposeDecision>;
}): Promise<string> {
  if (!options.client.configured || !options.client.senderAddress) {
    throw new Error("AgentMail is not configured for this speaker.");
  }
  const decision = await options.compose(options.transcript);
  if (decision.status === "needs_clarification") return decision.clarification;
  await options.client.sendMessage(
    { to: decision.to, subject: decision.subject, text: decision.text },
    agentMailIdempotencyKey(options.client.senderAddress, options.transcript),
  );
  return `Email sent to ${decision.to}.`;
}

export function agentMailIdempotencyKey(sender: string, transcript: string): string {
  const normalized = transcript.toLowerCase().replace(/\s+/g, " ").trim();
  const fingerprint = createHash("sha256")
    .update(`${sender.toLowerCase()}\n${normalized}`)
    .digest("hex");
  return `openhome-agentmail-${fingerprint}`;
}
