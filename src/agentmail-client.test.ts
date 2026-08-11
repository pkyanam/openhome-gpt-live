import { describe, expect, test } from "bun:test";
import { AgentMailClient } from "./agentmail-client.ts";

describe("AgentMail client", () => {
  test("requires the API key and selected inbox together", () => {
    expect(() => new AgentMailClient({ apiKey: "secret" })).toThrow("configured together");
    expect(() => new AgentMailClient({ inbox: "speaker@agentmail.to" })).toThrow("configured together");
    expect(new AgentMailClient().configured).toBe(false);
  });

  test("validates the exact selected inbox without listing the account", async () => {
    const requests: Request[] = [];
    const client = new AgentMailClient({
      apiKey: "am_test_secret",
      inbox: "speaker@agentmail.to",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          inbox_id: "inbox_123",
          email: "speaker@agentmail.to",
          display_name: "OpenHome <speaker@agentmail.to>",
        });
      },
    });

    await expect(client.verifyInbox()).resolves.toEqual({
      inboxId: "inbox_123",
      email: "speaker@agentmail.to",
      displayName: "OpenHome <speaker@agentmail.to>",
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/v0/inboxes/speaker%40agentmail.to");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer am_test_secret");
  });

  test("accepts an exact inbox-scoped key without inbox_read", async () => {
    const paths: string[] = [];
    const client = new AgentMailClient({
      apiKey: "am_scoped_secret",
      inbox: "speaker@agentmail.to",
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        paths.push(path);
        if (path === "/v0/auth/me") {
          return Response.json({
            scope_type: "inbox",
            scope_id: "speaker@agentmail.to",
            inbox_id: "speaker@agentmail.to",
          });
        }
        return new Response("Forbidden", { status: 403 });
      },
    });

    await expect(client.verifyInbox()).resolves.toEqual({
      inboxId: "speaker@agentmail.to",
      email: "speaker@agentmail.to",
    });
    expect(paths).toEqual([
      "/v0/inboxes/speaker%40agentmail.to",
      "/v0/auth/me",
    ]);
  });

  test("rejects a key scoped to a different inbox", async () => {
    const client = new AgentMailClient({
      apiKey: "am_wrong_scope",
      inbox: "speaker@agentmail.to",
      fetch: async (input) => new URL(input.toString()).pathname === "/v0/auth/me"
        ? Response.json({
            scope_type: "inbox",
            scope_id: "other@agentmail.to",
            inbox_id: "other@agentmail.to",
          })
        : new Response("Forbidden", { status: 403 }),
    });

    await expect(client.verifyInbox()).rejects.toThrow("scoped to a different inbox");
  });

  test("explains the read permission required by a broader key", async () => {
    const client = new AgentMailClient({
      apiKey: "am_organization_secret",
      inbox: "speaker@agentmail.to",
      fetch: async (input) => new URL(input.toString()).pathname === "/v0/auth/me"
        ? Response.json({
            scope_type: "organization",
            scope_id: "organization_123",
            organization_id: "organization_123",
          })
        : new Response("Forbidden", { status: 403 }),
    });

    await expect(client.verifyInbox()).rejects.toThrow(
      "organization-scoped AgentMail API key needs inbox_read",
    );
  });

  test("sends one plain-text message with an idempotency key", async () => {
    const requests: Request[] = [];
    const client = new AgentMailClient({
      apiKey: "am_test_secret",
      inbox: "speaker@agentmail.to",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ message_id: "message_123", thread_id: "thread_123" });
      },
    });

    await expect(client.sendMessage({
      to: "adi@agentmail.cc",
      subject: "A note of appreciation",
      text: "I really enjoy using AgentMail. Thank you for building it.",
    }, "openhome-agentmail-123")).resolves.toEqual({
      messageId: "message_123",
      threadId: "thread_123",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname)
      .toBe("/v0/inboxes/speaker%40agentmail.to/messages/send");
    expect(requests[0]!.headers.get("idempotency-key")).toBe("openhome-agentmail-123");
    expect(await requests[0]!.json()).toEqual({
      to: ["adi@agentmail.cc"],
      subject: "A note of appreciation",
      text: "I really enjoy using AgentMail. Thank you for building it.",
    });
  });

  test("does not include provider response bodies in safe errors", async () => {
    const client = new AgentMailClient({
      apiKey: "am_test_secret",
      inbox: "speaker@agentmail.to",
      fetch: async () => new Response("sensitive provider detail", { status: 403 }),
    });

    await expect(client.sendMessage({
      to: "adi@agentmail.cc",
      subject: "Hello",
      text: "Hello there.",
    }, "openhome-agentmail-403")).rejects.toThrow("AgentMail rejected the email");
    await expect(client.sendMessage({
      to: "adi@agentmail.cc",
      subject: "Hello",
      text: "Hello there.",
    }, "openhome-agentmail-403")).rejects.not.toThrow("sensitive provider detail");
  });
});
