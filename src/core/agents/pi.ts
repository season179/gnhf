import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  validateAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";
import { extractLastJsonObject, stripJsonFences } from "./json-extract.js";

interface PiAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

type JsonRecord = Record<string, unknown>;

type SegmentBlock = { delta: string; complete?: string };

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminatePiProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }

  child.kill("SIGTERM");
}

function buildPiPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant response must be only valid JSON matching this JSON Schema. Do not wrap it in Markdown fences. Do not include prose before or after the JSON object.

${JSON.stringify(schema, null, 2)}`;
}

function buildPiArgs(extraArgs?: string[]): string[] {
  return [...(extraArgs ?? []), "--mode", "json", "--no-session"];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function numberField(record: JsonRecord, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function toTokenUsage(usage: JsonRecord | undefined): TokenUsage | null {
  if (!usage) return null;

  return {
    inputTokens: numberField(usage, ["input"]) ?? 0,
    outputTokens: numberField(usage, ["output"]) ?? 0,
    cacheReadTokens: numberField(usage, ["cacheRead"]) ?? 0,
    cacheCreationTokens: numberField(usage, ["cacheWrite"]) ?? 0,
  };
}

function isSameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
}

function messageKey(message: JsonRecord): string | null {
  const responseId = stringField(message, ["responseId", "id"]);
  if (responseId) return responseId;

  const timestamp = message.timestamp;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return `timestamp:${timestamp}`;
  }

  return null;
}

function roleOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string"
    ? message.role
    : undefined;
}

function textFromContentBlock(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return null;
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return null;
}

function textFromAssistantMessage(message: JsonRecord | null): string {
  if (!message) return "";

  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(textFromContentBlock)
      .filter((text): text is string => text !== null)
      .join("");
  }

  return "";
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pick the structured-output JSON object from an ordered list of assistant
 * turn texts. pi is agentic: it often emits the valid JSON object in one turn,
 * then keeps working and ends with a prose summary, so the object is not the
 * last thing it says. We scan turns newest-first and prefer the strongest
 * signal:
 *
 *   Pass A - a whole turn that is itself the JSON object (optionally fenced)
 *            and satisfies `accepts`.
 *   Pass B - a JSON object embedded in a turn's prose that satisfies `accepts`.
 *
 * If nothing satisfies `accepts`, fall back to the most recent parseable object
 * (ignoring `accepts`) so the caller can run schema validation and surface a
 * precise "Invalid pi output" error rather than a generic parse failure.
 * Returns null only when no parseable JSON object exists anywhere.
 */
export function selectAgentJson(
  segments: string[],
  accepts: (value: unknown) => boolean,
): unknown | null {
  const tryParse = (text: string): unknown | undefined => {
    const cleaned = stripJsonFences(text);
    if (!cleaned) return undefined;
    try {
      return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  };

  // Pass A: a whole turn that is pure JSON and is a valid AgentOutput.
  for (let i = segments.length - 1; i >= 0; i--) {
    const parsed = tryParse(segments[i]);
    if (parsed !== undefined && accepts(parsed)) return parsed;
  }
  // Pass B: a valid AgentOutput object embedded in a turn's prose.
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = extractLastJsonObject(segments[i], accepts);
    if (found !== null) {
      try {
        return JSON.parse(found);
      } catch {
        // keep scanning earlier turns
      }
    }
  }
  // Fallback: the most recent parseable object, valid or not, for diagnostics.
  for (let i = segments.length - 1; i >= 0; i--) {
    const parsed = tryParse(segments[i]);
    if (parsed !== undefined) return parsed;
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = extractLastJsonObject(segments[i]);
    if (found !== null) {
      try {
        return JSON.parse(found);
      } catch {
        // keep scanning earlier turns
      }
    }
  }
  return null;
}

export class PiAgent implements Agent {
  name = "pi";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: PiAgentDeps = {}) {
    this.bin = deps.bin ?? "pi";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;
      const child = spawn(this.bin, buildPiArgs(this.extraArgs), {
        cwd,
        detached: this.platform !== "win32",
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      child.stdin?.write(buildPiPrompt(prompt, this.schema));
      child.stdin?.end();

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminatePiProcess(child, this.platform),
        )
      ) {
        return;
      }

      let latestAssistantMessage: JsonRecord | null = null;
      const usageByMessageKey = new Map<string, TokenUsage>();
      let lastEmittedUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      let anonymousKeySeq = 0;
      let currentStreamingMessageKey: string | null = null;

      // Accumulate assistant text per message/turn so we can recover the
      // structured object even when pi keeps talking afterwards. Keyed by pi's
      // stable message id when present, else a per-turn synthetic key - never
      // by contentIndex or role, which collide across turns.
      const finalizedSegments: string[] = [];
      const finalizedKeys = new Set<string>();
      const blocksByKey = new Map<string, Map<number, SegmentBlock>>();
      let activeSegmentKey: string | null = null;
      let syntheticSegmentSeq = 0;
      let capturedAnyAssistant = false;

      const segmentKeyFor = (message: JsonRecord | null): string => {
        const stable = message ? messageKey(message) : null;
        if (stable !== null) {
          activeSegmentKey = stable;
          return stable;
        }
        if (activeSegmentKey !== null) return activeSegmentKey;
        const key = `pi-turn-${syntheticSegmentSeq++}`;
        activeSegmentKey = key;
        return key;
      };

      const blocksFor = (key: string): Map<number, SegmentBlock> => {
        let blocks = blocksByKey.get(key);
        if (!blocks) {
          blocks = new Map();
          blocksByKey.set(key, blocks);
        }
        return blocks;
      };

      const joinBlocks = (key: string): string => {
        const blocks = blocksByKey.get(key);
        if (!blocks) return "";
        return [...blocks.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, block]) => block.complete ?? block.delta)
          .join("");
      };

      const finalizeSegment = (key: string, message: JsonRecord | null) => {
        if (finalizedKeys.has(key)) return;
        finalizedKeys.add(key);
        const messageText = message ? textFromAssistantMessage(message) : "";
        const text = messageText.trim() ? messageText : joinBlocks(key);
        finalizedSegments.push(text);
        if (activeSegmentKey === key) activeSegmentKey = null;
      };

      const updateUsage = (message: JsonRecord, streaming = false) => {
        const usage = isRecord(message.usage)
          ? toTokenUsage(message.usage)
          : null;
        if (!usage) return;

        let key = messageKey(message);
        if (key === null) {
          if (streaming && currentStreamingMessageKey !== null) {
            key = currentStreamingMessageKey;
          } else {
            key = `assistant-anonymous-${anonymousKeySeq++}`;
            if (streaming) currentStreamingMessageKey = key;
          }
        }
        usageByMessageKey.set(key, usage);

        const cumulative: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        for (const entry of usageByMessageKey.values()) {
          cumulative.inputTokens += entry.inputTokens;
          cumulative.outputTokens += entry.outputTokens;
          cumulative.cacheReadTokens += entry.cacheReadTokens;
          cumulative.cacheCreationTokens += entry.cacheCreationTokens;
        }

        if (!isSameUsage(cumulative, lastEmittedUsage)) {
          lastEmittedUsage = cumulative;
          onUsage?.({ ...cumulative });
        }
      };

      const rememberAssistantMessage = (
        message: unknown,
        streaming = false,
      ) => {
        if (!isRecord(message) || roleOf(message) !== "assistant") return;
        latestAssistantMessage = message;
        updateUsage(message, streaming);
      };

      parseJSONLStream<JsonRecord>(child.stdout!, logStream, (event) => {
        if (!isRecord(event)) return;

        if (event.type === "message_start" || event.type === "turn_start") {
          // A new assistant turn begins: drop the active key so the next
          // streamed text (or message_end) starts a fresh segment instead of
          // merging into the previous turn when ids are absent.
          activeSegmentKey = null;
        }

        if (event.type === "message_update") {
          rememberAssistantMessage(event.message, true);

          if (isRecord(event.assistantMessageEvent)) {
            const assistantEvent = event.assistantMessageEvent;
            const contentIndex =
              numberField(assistantEvent, ["contentIndex", "content_index"]) ??
              0;
            const message = isRecord(event.message) ? event.message : null;

            if (assistantEvent.type === "text_delta") {
              const delta = stringField(assistantEvent, [
                "delta",
                "text",
                "content",
              ]);
              if (delta) {
                capturedAnyAssistant = true;
                const blocks = blocksFor(segmentKeyFor(message));
                const block = blocks.get(contentIndex) ?? { delta: "" };
                block.delta += delta;
                blocks.set(contentIndex, block);
                const visible = block.delta.trim();
                if (visible) onMessage?.(visible);
              }
            }

            if (assistantEvent.type === "text_end") {
              capturedAnyAssistant = true;
              const blocks = blocksFor(segmentKeyFor(message));
              const block = blocks.get(contentIndex) ?? { delta: "" };
              const text =
                stringField(assistantEvent, ["text", "content"]) ??
                block.delta;
              block.complete = text;
              blocks.set(contentIndex, block);
              const visible = text.trim();
              if (visible) onMessage?.(visible);
            }
          }
        }

        if (event.type === "message_end" || event.type === "turn_end") {
          rememberAssistantMessage(event.message, true);
          currentStreamingMessageKey = null;
          const message = isRecord(event.message) ? event.message : null;
          if (message && roleOf(message) === "assistant") {
            capturedAnyAssistant = true;
            finalizeSegment(segmentKeyFor(message), message);
          } else if (activeSegmentKey !== null) {
            finalizeSegment(activeSegmentKey, null);
          }
        }

        if (
          event.type === "agent_end" &&
          Array.isArray(event.messages) &&
          !capturedAnyAssistant
        ) {
          for (let i = event.messages.length - 1; i >= 0; i -= 1) {
            const message = event.messages[i];
            if (roleOf(message) === "assistant") {
              rememberAssistantMessage(message);
              finalizedSegments.push(
                textFromAssistantMessage(message as JsonRecord),
              );
              capturedAnyAssistant = true;
              break;
            }
          }
        }
      });

      setupChildProcessHandlers(child, "pi", logStream, reject, () => {
        if (latestAssistantMessage) {
          const stopReason = latestAssistantMessage.stopReason;
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage =
              stringField(latestAssistantMessage, [
                "errorMessage",
                "error",
                "message",
              ]) ?? compactJson(latestAssistantMessage);
            reject(new Error(`pi reported error: ${errorMessage}`));
            return;
          }
        }

        // Finalize any assistant turn still in progress (pi exited without a
        // closing message_end/turn_end for it).
        for (const key of blocksByKey.keys()) {
          if (!finalizedKeys.has(key)) finalizeSegment(key, null);
        }

        const hasText = finalizedSegments.some(
          (segment) => segment.trim().length > 0,
        );
        if (!hasText) {
          reject(new Error("pi returned no text output"));
          return;
        }

        const acceptsValid = (value: unknown): boolean => {
          try {
            validateAgentOutput(value, this.schema);
            return true;
          } catch {
            return false;
          }
        };

        const candidate = selectAgentJson(finalizedSegments, acceptsValid);
        if (candidate === null) {
          reject(
            new Error(
              "Failed to parse pi output: no JSON object found in assistant output",
            ),
          );
          return;
        }

        try {
          const output = validateAgentOutput(candidate, this.schema);
          resolve({ output, usage: lastEmittedUsage });
        } catch (err) {
          reject(
            new Error(
              `Invalid pi output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
