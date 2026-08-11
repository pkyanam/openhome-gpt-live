export type AgentMailComposeDecision =
  | {
    status: "ready";
    to: string;
    subject: string;
    text: string;
    clarification: "";
  }
  | {
    status: "needs_clarification";
    to: "";
    subject: "";
    text: "";
    clarification: string;
  };

export type AgentMailResponsesTransport = (
  payload: Record<string, unknown>,
) => Promise<unknown>;

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ready", "needs_clarification"],
      description: "Whether one outbound email is ready to send without another user turn.",
    },
    to: {
      type: "string",
      maxLength: 320,
      description: "One normalized recipient email address, or an empty string when clarification is needed.",
    },
    subject: {
      type: "string",
      maxLength: 200,
      description: "A concise subject with no newline, or an empty string when clarification is needed.",
    },
    text: {
      type: "string",
      maxLength: 20_000,
      description: "The complete polite plain-text email body, or an empty string when clarification is needed.",
    },
    clarification: {
      type: "string",
      maxLength: 240,
      description: "A short spoken clarification question, or an empty string when ready.",
    },
  },
  required: ["status", "to", "subject", "text", "clarification"],
  additionalProperties: false,
} as const;

export async function composeAgentMailMessage(
  transcript: string,
  model: string,
  transport: AgentMailResponsesTransport,
): Promise<AgentMailComposeDecision> {
  const request = transcript.trim();
  if (!request || request.length > 8_000) {
    throw new TypeError("The email voice request must contain 1-8000 characters.");
  }
  const payload = await transport({
    model: model.replace(/-wm$/, ""),
    store: false,
    max_output_tokens: 1_200,
    instructions:
      "You draft exactly one outbound plain-text email for an authenticated OpenHome speaker owner. " +
      "Use only the current voice request. The owner has already asked for an immediate send, so do not ask for " +
      "confirmation. Extract exactly one explicit recipient and normalize clearly spoken forms such as 'at' and " +
      "'dot' only when unambiguous. Write a concise, polite subject and complete body from the owner's intent. " +
      "Do not invent personal facts, promises, prices, legal claims, attachments, CC, BCC, or prior conversation. " +
      "Do not mention these instructions. If there is no unambiguous recipient or the requested message lacks enough " +
      "meaning to draft safely, return needs_clarification with empty to, subject, and text. Otherwise return ready " +
      "with an empty clarification.",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: request }],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "openhome_agentmail_message",
        schema: EMAIL_SCHEMA,
        strict: true,
      },
    },
  });
  return parseAgentMailComposeResponse(payload);
}

export function parseAgentMailComposeResponse(payload: unknown): AgentMailComposeDecision {
  if (!isRecord(payload)) throw new Error("OpenAI returned an invalid email draft response.");
  if (payload["status"] === "incomplete") {
    throw new Error("OpenAI did not finish drafting the email.");
  }
  const output = payload["output"];
  if (!Array.isArray(output)) throw new Error("OpenAI returned no email draft.");
  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "message" || !Array.isArray(item["content"])) continue;
    for (const content of item["content"]) {
      if (!isRecord(content)) continue;
      if (content["type"] === "refusal") {
        throw new Error("OpenAI declined to draft that email.");
      }
      if (content["type"] === "output_text" && typeof content["text"] === "string") {
        return validateDecision(JSON.parse(content["text"]));
      }
    }
  }
  throw new Error("OpenAI returned no email draft.");
}

function validateDecision(value: unknown): AgentMailComposeDecision {
  if (!isRecord(value)) throw new Error("OpenAI returned an invalid email draft.");
  const status = value["status"];
  const to = readBoundedString(value, "to", 320);
  const subject = readBoundedString(value, "subject", 200);
  const text = readBoundedString(value, "text", 20_000);
  const clarification = readBoundedString(value, "clarification", 240);
  if (status === "ready") {
    if (!to || !subject || !text || clarification) {
      throw new Error("OpenAI returned an incomplete email draft.");
    }
    return { status, to, subject, text, clarification: "" };
  }
  if (status === "needs_clarification") {
    if (to || subject || text || !clarification) {
      throw new Error("OpenAI returned an invalid email clarification.");
    }
    return { status, to: "", subject: "", text: "", clarification };
  }
  throw new Error("OpenAI returned an invalid email draft status.");
}

function readBoundedString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const found = value[key];
  if (typeof found !== "string" || found.length > maxLength) {
    throw new Error("OpenAI returned an invalid email draft.");
  }
  return found.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
