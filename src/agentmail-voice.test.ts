import { describe, expect, test } from "bun:test";
import { AgentMailClient } from "./agentmail-client.ts";
import { agentMailIdempotencyKey, executeAgentMailVoiceRequest } from "./agentmail-voice.ts";

describe("AgentMail voice execution", () => {
  test("drafts and sends exactly one idempotent email", async () => {
    const requests: Request[] = [];
    const client = new AgentMailClient({
      apiKey: "am_test_secret",
      inbox: "speaker@agentmail.to",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ message_id: "message_1", thread_id: "thread_1" });
      },
    });
    const transcript = "Please send an email to adi@agentmail.cc about how much I love his product.";

    await expect(executeAgentMailVoiceRequest({
      transcript,
      client,
      compose: async () => ({
        status: "ready",
        to: "adi@agentmail.cc",
        subject: "A note of appreciation",
        text: "Hi Adi,\n\nI love what you have built. Thank you.\n\nBest,",
        clarification: "",
      }),
    })).resolves.toBe("Email sent to adi@agentmail.cc.");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("idempotency-key"))
      .toBe(agentMailIdempotencyKey("speaker@agentmail.to", transcript));
  });

  test("asks for missing information without sending", async () => {
    let sends = 0;
    const client = new AgentMailClient({
      apiKey: "am_test_secret",
      inbox: "speaker@agentmail.to",
      fetch: async () => {
        sends += 1;
        return Response.json({ message_id: "message_1", thread_id: "thread_1" });
      },
    });

    await expect(executeAgentMailVoiceRequest({
      transcript: "Send an email saying thanks.",
      client,
      compose: async () => ({
        status: "needs_clarification",
        to: "",
        subject: "",
        text: "",
        clarification: "What email address should I send it to?",
      }),
    })).resolves.toBe("What email address should I send it to?");
    expect(sends).toBe(0);
  });

  test("uses the same provider key for normalized retries", () => {
    expect(agentMailIdempotencyKey(
      "SPEAKER@agentmail.to",
      "Send   an email to adi@agentmail.cc",
    )).toBe(agentMailIdempotencyKey(
      "speaker@agentmail.to",
      " send an EMAIL to adi@agentmail.cc ",
    ));
  });
});
