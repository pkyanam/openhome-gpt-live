import type {
  RealtimeAppServerConfirmationContext,
  RealtimeAppServerToolContext,
  RealtimeConfirmationResult,
  RealtimeDynamicTool,
  RealtimeToolResult,
} from "@opencoredev/loginwithchatgpt-server";
import { OpenHomeClient, type ToggleAbilityInput } from "./openhome-client.ts";

const TOGGLE_OPERATION = "openhome.toggle_ability.v1";

export interface OpenHomeToolPolicy {
  tools: readonly RealtimeDynamicTool[];
  executeTool(context: RealtimeAppServerToolContext): Promise<RealtimeToolResult>;
  confirmTool(context: RealtimeAppServerConfirmationContext): Promise<RealtimeConfirmationResult>;
}

export function createOpenHomeToolPolicy(client: OpenHomeClient): OpenHomeToolPolicy {
  return {
    tools: OPENHOME_TOOLS,
    async executeTool({ name, arguments: args }) {
      switch (name) {
        case "openhome_list_agents":
          requireNoArguments(args);
          return { output: await client.listAgents() };
        case "openhome_list_abilities": {
          const scope = requireEnum(args, "scope", ["all", "installed"] as const);
          return { output: await client.listAbilities(scope) };
        }
        case "openhome_prepare_ability_toggle": {
          const operation = parseToggleInput(args);
          return {
            output: {
              status: "pending_confirmation",
              operation: TOGGLE_OPERATION,
              input: operation,
            },
            pendingConfirmation: {
              review: {
                title: operation.enabled ? "Enable OpenHome Ability" : "Disable OpenHome Ability",
                installedCapabilityId: operation.installedCapabilityId,
                enabled: operation.enabled,
                triggerWords: operation.triggerWords,
              },
            },
          };
        }
        default:
          throw new Error(`Unknown OpenHome tool: ${name}`);
      }
    },
    async confirmTool({ confirmation, pending }) {
      const approved = parseApproved(confirmation);
      const operation = parsePendingToggle(pending.output);
      if (!approved) {
        return {
          output: { status: "cancelled", operation: TOGGLE_OPERATION },
          speech: "Okay, I left that Ability unchanged.",
        };
      }
      const result = await client.toggleAbility(operation);
      return {
        output: { status: "completed", operation: TOGGLE_OPERATION, result },
        speech: operation.enabled
          ? "The OpenHome Ability is enabled."
          : "The OpenHome Ability is disabled.",
      };
    },
  };
}

const OPENHOME_TOOLS: readonly RealtimeDynamicTool[] = [
  {
    type: "function",
    name: "openhome_list_agents",
    description: "List the authenticated user's OpenHome Agents and their IDs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "openhome_list_abilities",
    description: "List all OpenHome Abilities or only the Abilities installed on the account.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "installed"] },
      },
      required: ["scope"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "openhome_prepare_ability_toggle",
    description:
      "Prepare enabling or disabling an installed OpenHome Ability. This never mutates state until the host UI confirms it.",
    inputSchema: {
      type: "object",
      properties: {
        installedCapabilityId: { type: "integer", minimum: 1 },
        enabled: { type: "boolean" },
        triggerWords: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
      required: ["installedCapabilityId", "enabled", "triggerWords"],
      additionalProperties: false,
    },
  },
] as const;

function requireNoArguments(args: Record<string, unknown>): void {
  if (Object.keys(args).length !== 0) throw new TypeError("This tool does not accept arguments.");
}

function requireEnum<const T extends readonly string[]>(
  args: Record<string, unknown>,
  name: string,
  values: T,
): T[number] {
  const value = args[name];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as T[number];
}

function parseToggleInput(args: Record<string, unknown>): ToggleAbilityInput {
  const installedCapabilityId = args["installedCapabilityId"];
  const enabled = args["enabled"];
  const triggerWords = args["triggerWords"];
  if (!Number.isInteger(installedCapabilityId) || (installedCapabilityId as number) < 1) {
    throw new TypeError("installedCapabilityId must be a positive integer.");
  }
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean.");
  if (!Array.isArray(triggerWords) || triggerWords.length < 1 || triggerWords.length > 30) {
    throw new TypeError("triggerWords must contain between 1 and 30 items.");
  }
  const normalized = triggerWords.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 80) {
      throw new TypeError("Each trigger word must be a non-empty string of at most 80 characters.");
    }
    return value.trim();
  });
  return { installedCapabilityId: installedCapabilityId as number, enabled, triggerWords: normalized };
}

function parseApproved(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Confirmation must be an object.");
  }
  const approved = (value as Record<string, unknown>)["approved"];
  if (typeof approved !== "boolean") throw new TypeError("confirmation.approved must be a boolean.");
  return approved;
}

function parsePendingToggle(value: unknown): ToggleAbilityInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Pending OpenHome operation is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record["operation"] !== TOGGLE_OPERATION) {
    throw new TypeError("Pending OpenHome operation is not an Ability toggle.");
  }
  const input = record["input"];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Pending OpenHome toggle input is invalid.");
  }
  return parseToggleInput(input as Record<string, unknown>);
}
