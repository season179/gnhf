import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  validateAgentOutput,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
  PermanentAgentError,
} from "./types.js";
import { parseAgentJson } from "./json-extract.js";
import { parseJSONLStream, setupAbortHandler } from "./stream-utils.js";

const CURSOR_HELP_PROBE_TIMEOUT_MS = 5_000;

// Cursor CLI stream-json event shapes (subset we care about).
// See https://cursor.com/docs/cli/overview - `agent -p --output-format stream-json`.

interface CursorAssistantMessage {
  role: string;
  content?: Array<
    { type: "text"; text?: string } | { type: string; [key: string]: unknown }
  >;
}

interface CursorAssistantEvent {
  type: "assistant";
  message: CursorAssistantMessage;
  timestamp_ms?: number;
  model_call_id?: string;
}

interface CursorResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

type CursorEvent = CursorAssistantEvent | CursorResultEvent | { type: string };

interface CursorAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

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

function commandExists(bin: string, platform: NodeJS.Platform): boolean {
  try {
    execFileSync(platform === "win32" ? "where" : "which", [bin], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isCursorStandaloneAgent(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    const help = execFileSync(bin, ["--help"], {
      encoding: "utf8",
      shell: shouldUseWindowsShell(bin, platform),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CURSOR_HELP_PROBE_TIMEOUT_MS,
    });
    return (
      /^Usage:\s+(?:agent|cursor-agent|cursor\s+agent)(?:\s|\[)/m.test(help) &&
      /Start the Cursor Agent/i.test(help)
    );
  } catch {
    return false;
  }
}

function isCursorEditorLauncherWithAgentSubcommand(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    const help = execFileSync(bin, ["--help"], {
      encoding: "utf8",
      shell: shouldUseWindowsShell(bin, platform),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CURSOR_HELP_PROBE_TIMEOUT_MS,
    });
    return (
      /^Usage:\s+cursor(?:\s|\[)/m.test(help) &&
      /^\s+agent\s+Start the Cursor agent in your terminal\./im.test(help)
    );
  } catch {
    return false;
  }
}

function resolveDefaultCursorBin(platform: NodeJS.Platform): string {
  const hasCursor = commandExists("cursor", platform);
  if (
    hasCursor &&
    isCursorEditorLauncherWithAgentSubcommand("cursor", platform)
  ) {
    return "cursor";
  }

  if (
    commandExists("cursor-agent", platform) &&
    isCursorStandaloneAgent("cursor-agent", platform)
  ) {
    return "cursor-agent";
  }

  if (
    commandExists("agent", platform) &&
    isCursorStandaloneAgent("agent", platform)
  ) {
    return "agent";
  }

  if (hasCursor) {
    return "cursor";
  }

  return "cursor";
}

function terminateCursorProcess(
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

  child.kill("SIGTERM");
}

function isPermanentCursorError(stderr: string): boolean {
  return (
    /provided API key is invalid/i.test(stderr) ||
    /authentication required/i.test(stderr) ||
    /unknown option/i.test(stderr)
  );
}

function isMissingCursorBinary(error: Error): boolean {
  return (
    ("code" in error && error.code === "ENOENT") || /ENOENT/.test(error.message)
  );
}

function isNonRunnableCursorBinary(error: Error): boolean {
  const nonRunnableCodes = new Set(["EACCES", "EPERM", "ENOEXEC"]);
  return (
    ("code" in error &&
      typeof error.code === "string" &&
      nonRunnableCodes.has(error.code)) ||
    /\b(?:EACCES|EPERM|ENOEXEC)\b/.test(error.message)
  );
}

// Cursor's --force/--yolo flags and read-only modes govern whether print-mode
// runs apply changes. If the user supplies one, don't add our default --force.
function userSpecifiedExecutionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--force" ||
      arg === "-f" ||
      arg === "--yolo" ||
      arg === "--mode" ||
      arg.startsWith("--mode=") ||
      arg === "--plan",
  );
}

function shouldAddAgentSubcommand(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  const executable = bin.split(/[\\/]/).pop() ?? bin;
  const normalized = executable.toLowerCase().replace(/\.(cmd|bat|exe)$/i, "");

  if (normalized === "agent" || normalized === "cursor-agent") {
    return false;
  }

  return !isCursorStandaloneAgent(bin, platform);
}

function buildCursorPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Return only the JSON object in the final answer. Do not wrap it in Markdown. Do not include explanatory prose outside the JSON object.`;
}

function buildCursorArgs(
  bin: string,
  prompt: string,
  schema: AgentOutputSchema,
  platform: NodeJS.Platform,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...(shouldAddAgentSubcommand(bin, platform) ? ["agent"] : []),
    ...userArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    ...(userSpecifiedExecutionMode(userArgs) ? [] : ["--force"]),
    buildCursorPrompt(prompt, schema),
  ];
}

function usageFromRecord(usage: CursorResultEvent["usage"]): TokenUsage | null {
  if (!usage) return null;

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheCreationTokens = usage.cacheWriteTokens;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
  };
}

function textFromAssistantMessage(message: CursorAssistantMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && block.type === "text"
        ? (block.text ?? "")
        : "",
    )
    .join("");
}

function isCursorStreamingDelta(event: CursorAssistantEvent): boolean {
  return "timestamp_ms" in event && !("model_call_id" in event);
}

function isCursorPreToolFlush(event: CursorAssistantEvent): boolean {
  return "model_call_id" in event;
}

function parseCursorOutput(
  text: string,
  schema: AgentOutputSchema,
): AgentOutput {
  const parsed = parseAgentJson(text, (value) => {
    try {
      validateAgentOutput(value, schema);
      return true;
    } catch {
      return false;
    }
  });
  if (parsed !== null) {
    return validateAgentOutput(parsed, schema);
  }

  const fallbackParsed = parseAgentJson(text);
  if (fallbackParsed !== null) {
    return validateAgentOutput(fallbackParsed, schema);
  }

  throw new SyntaxError(
    "cursor output did not contain a parseable JSON object",
  );
}

export class CursorAgent implements Agent {
  name = "cursor";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | CursorAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.bin = deps.bin ?? resolveDefaultCursorBin(this.platform);
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

      const child = spawn(
        this.bin,
        buildCursorArgs(
          this.bin,
          prompt,
          this.schema,
          this.platform,
          this.extraArgs,
        ),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCursorProcess(child, this.platform),
        )
      ) {
        return;
      }

      // The final `result` event carries the concatenated assistant text and
      // the authoritative usage totals, so we prefer it over reconstructing
      // from streamed assistant messages. Partial assistant deltas are still
      // accumulated and sent to onMessage for live renderer feedback.
      let lastAssistantText: string | null = null;
      let resultEvent: CursorResultEvent | null = null;
      let assistantTextBuffer = "";
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      let stderr = "";

      parseJSONLStream<CursorEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant" && "message" in event) {
          const assistantEvent = event as CursorAssistantEvent;
          if (!isCursorStreamingDelta(assistantEvent)) {
            if (isCursorPreToolFlush(assistantEvent)) {
              assistantTextBuffer = "";
            }
            return;
          }

          const text = textFromAssistantMessage(assistantEvent.message);
          if (text) {
            assistantTextBuffer += text;
            const displayText = assistantTextBuffer.trim();
            if (displayText) {
              lastAssistantText = displayText;
              onMessage?.(displayText);
            }
          }
        }

        if (event.type === "result" && "result" in event) {
          resultEvent = event as CursorResultEvent;
          const usage = usageFromRecord(resultEvent.usage);
          if (usage) {
            cumulative.inputTokens = usage.inputTokens;
            cumulative.outputTokens = Math.max(
              cumulative.outputTokens,
              usage.outputTokens,
            );
            cumulative.cacheReadTokens = usage.cacheReadTokens;
            cumulative.cacheCreationTokens = usage.cacheCreationTokens;
            onUsage?.({ ...cumulative });
          }
        }
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        const detail = `Failed to spawn cursor: ${err.message}`;
        reject(
          isMissingCursorBinary(err)
            ? new PermanentAgentError(
                "cursor executable was not found - install Cursor CLI or configure agentPathOverride.cursor",
                detail,
              )
            : isNonRunnableCursorBinary(err)
              ? new PermanentAgentError(
                  "cursor executable is not runnable - check Cursor CLI install or agentPathOverride.cursor permissions",
                  detail,
                )
              : new Error(detail),
        );
      });

      child.on("close", (code) => {
        logStream?.end();
        if (code !== 0) {
          const detail = `cursor exited with code ${code}: ${stderr}`;
          reject(
            isPermanentCursorError(stderr)
              ? new PermanentAgentError(
                  "cursor failed before headless run could start - see gnhf.log",
                  detail,
                )
              : new Error(detail),
          );
          return;
        }

        if (!resultEvent) {
          reject(new Error("cursor returned no result event"));
          return;
        }

        if (resultEvent.is_error || resultEvent.subtype !== "success") {
          reject(
            new Error(`cursor reported error: ${JSON.stringify(resultEvent)}`),
          );
          return;
        }

        const finalText = resultEvent.result.trim() || lastAssistantText;
        if (!finalText) {
          reject(new Error("cursor returned no agent message"));
          return;
        }

        try {
          const output = parseCursorOutput(finalText, this.schema);
          resolve({ output, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse cursor output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
