import type { BridgeEvent, SessionView, ViewMessage, WorkspaceListView } from "./bridge-contract.ts";
import { SESSION_SCHEMA_VERSION } from "./bridge-contract.ts";

// Validate known fields, allow additive fields and preserve plugin-owned data as opaque.
type RecordValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const string: Check = value => typeof value === "string";
const boolean: Check = value => typeof value === "boolean";
const number: Check = value => typeof value === "number" && Number.isFinite(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const optional = (value: RecordValue, key: string, check: Check) => value[key] === undefined || check(value[key]);
const strings = (value: RecordValue, keys: readonly string[]) => keys.every(key => string(value[key]));
const optionalStrings = (value: RecordValue, keys: readonly string[]) => keys.every(key => optional(value, key, string));

function message(value: unknown): value is ViewMessage {
  return record(value)
    && strings(value, ["id", "timestamp"])
    && ["user", "assistant", "tool", "notice"].includes(value.role as string)
    && array(block => record(block) && ["text", "thinking", "image", "toolCall"].includes(block.kind as string)
      && string(block.text) && optionalStrings(block, ["toolName", "toolCallId"]))(value.blocks)
    && optionalStrings(value, ["toolName", "toolCallId", "model", "error"])
    && optional(value, "isError", boolean)
    && optional(value, "usage", usage => record(usage)
      && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every(key => number(usage[key]))
      && optional(usage, "reasoning", number));
}

function session(value: unknown): value is SessionView {
  return record(value) && value.schemaVersion === SESSION_SCHEMA_VERSION
    && strings(value, ["sessionId", "cwd", "name"])
    && nullable(string)(value.model) && nullable(string)(value.thinkingLevel)
    && array(string)(value.thinkingLevels) && boolean(value.idle) && optional(value, "paused", boolean)
    && optional(value, "hasPendingPrompts", boolean)
    && optional(value, "promptQueue", queue => record(queue) && array(string)(queue.steering) && array(string)(queue.followUp))
    && optional(value, "queuedPrompts", array(item => record(item) && strings(item, ["id", "text"])
      && Number.isSafeInteger(item.revision) && (item.revision as number) > 0
      && ["queued", "sending"].includes(item.status as string) && optional(item, "error", string)
      && array(file => record(file) && string(file.name) && boolean(file.image))(item.attachments)))
    && nullable(usage => record(usage) && nullable(number)(usage.tokens)
      && number(usage.contextWindow) && nullable(number)(usage.percent))(value.contextUsage)
    && array(message)(value.messages)
    && array(entry => record(entry) && strings(entry, ["id", "pluginId", "kind", "timestamp"])
      && optional(entry, "afterMessageId", string))(value.pluginEntries)
    && optional(value, "interactions", array(interaction => record(interaction)
      && strings(interaction, ["requestId", "sessionId", "pluginId", "kind"])))
    && optional(value, "streaming", nullable(message));
}

function workspaces(value: unknown): value is WorkspaceListView {
  return record(value) && nullable(string)(value.activeId)
    && array(item => record(item) && strings(item, ["id", "path", "title"]) && optional(item, "available", boolean))(value.items)
    && array(item => record(item) && strings(item, ["id", "workspaceId", "name", "modified"])
      && nullable(string)(item.path) && optional(item, "idle", boolean))(value.sessions);
}

function errorEvent(value: unknown): value is Extract<BridgeEvent, { type: "error" }> {
  return record(value) && value.type === "error" && string(value.message)
    && optionalStrings(value, ["errorCode", "errorId", "requestId", "operationId"])
    && optional(value, "errorReported", boolean);
}

/** Reject malformed events before they enter UI state; errors never echo wire content. */
export function parseBridgeEvent(value: unknown): BridgeEvent {
  if (!record(value) || !string(value.type)) throw new Error("Invalid stream event");
  switch (value.type) {
    case "snapshot":
      if (record(value.session) && value.session.schemaVersion !== SESSION_SCHEMA_VERSION) throw new Error("Unsupported session schema");
      if (session(value.session)) return { type: "snapshot", session: value.session };
      throw new Error("Invalid session snapshot");
    case "stream":
      if (value.message === null || message(value.message)) return { type: "stream", message: value.message };
      break;
    case "workspaces":
      if (workspaces(value.value)) return { type: "workspaces", value: value.value };
      break;
    case "shutdown":
      if (optional(value, "reconnect", boolean)) return { type: "shutdown", ...(value.reconnect === undefined ? {} : { reconnect: value.reconnect as boolean }) };
      break;
    case "plugins_changed": return { type: "plugins_changed" };
    case "hosted_plugins_changed": return { type: "hosted_plugins_changed" };
    case "plugin_state":
      if (Array.isArray(value.disabled) && value.disabled.every(id => typeof id === "string" && id.length <= 200)) return { type: "plugin_state", disabled: value.disabled };
      break;
    case "error":
      if (errorEvent(value)) return value;
      break;
    default: throw new Error("Unsupported stream event");
  }
  throw new Error("Invalid stream event");
}
