import { describe, expect, test } from "bun:test";
import { composeAgentMailMessage, parseAgentMailComposeResponse } from "./agentmail-composer.ts";

function response(value: unknown): Record<string, unknown> {
  return {
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  };
}

describe("AgentMail email composition", () => {
  test("uses strict structured output through the authenticated Responses transport", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await composeAgentMailMessage(
      "Send an email to adi at agentmail dot cc about how much I love his product.",
      "gpt-5.5-wm",
      async (payload) => {
        requests.push(payload);
        return response({
          status: "ready",
          to: "adi@agentmail.cc",
          subject: "Appreciation for AgentMail",
          text: "Hi Adi,\n\nI wanted to say how much I enjoy AgentMail. Thank you for building it.\n\nBest,",
          clarification: "",
        });
      },
    );

    expect(result.status).toBe("ready");
    expect(result.to).toBe("adi@agentmail.cc");
    expect(requests[0]?.model).toBe("gpt-5.5");
    expect(requests[0]?.store).toBe(false);
    expect((requests[0]?.text as any).format).toMatchObject({
      type: "json_schema",
      name: "openhome_agentmail_message",
      strict: true,
    });
  });

  test("returns a spoken clarification without inventing a recipient", () => {
    expect(parseAgentMailComposeResponse(response({
      status: "needs_clarification",
      to: "",
      subject: "",
      text: "",
      clarification: "What email address should I send it to?",
    }))).toEqual({
      status: "needs_clarification",
      to: "",
      subject: "",
      text: "",
      clarification: "What email address should I send it to?",
    });
  });

  test("rejects incomplete or refused drafts", () => {
    expect(() => parseAgentMailComposeResponse({ status: "incomplete", output: [] }))
      .toThrow("did not finish");
    expect(() => parseAgentMailComposeResponse({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    })).toThrow("declined");
    expect(() => parseAgentMailComposeResponse(response({
      status: "ready",
      to: "adi@agentmail.cc",
      subject: "",
      text: "Hello",
      clarification: "",
    }))).toThrow("incomplete");
  });
});
