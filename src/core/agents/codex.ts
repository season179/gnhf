import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { PermanentAgentError } from "./types.js";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text: string };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

interface CodexErrorEvent {
  type: "error";
  message: string;
}

interface CodexTurnFailed {
  type: "turn.failed";
  error: { message?: string };
}

type CodexEvent =
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexErrorEvent
  | CodexTurnFailed
  | { type: string };

interface CodexAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
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

function terminateCodexProcess(
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

function buildCodexArgs(
  prompt: string,
  schemaPath: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedExecutionMode = userArgs.some(
    (arg) =>
      arg === "--full-auto" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-s" ||
      arg === "--ask-for-approval" ||
      arg.startsWith("--ask-for-approval=") ||
      arg === "-a",
  );

  return [
    "exec",
    ...userArgs,
    prompt,
    "--json",
    "--output-schema",
    schemaPath,
    ...(userSpecifiedExecutionMode
      ? []
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--color",
    "never",
  ];
}

function isPermanentCodexError(message: string): boolean {
  return /usage limit|purchase more credits/i.test(message);
}

function buildCodexExitError(
  code: number | null,
  stderr: string,
  structuredError: string | null,
): Error {
  const trimmedStructuredError = structuredError?.trim() ?? "";
  const trimmedStderr = stderr.trim();
  const primaryMessage = trimmedStructuredError || trimmedStderr;
  const detail =
    trimmedStructuredError && trimmedStderr
      ? `codex exited with code ${code}: ${trimmedStructuredError}\n\nstderr: ${trimmedStderr}`
      : `codex exited with code ${code}: ${primaryMessage}`;

  return isPermanentCodexError(primaryMessage)
    ? new PermanentAgentError(
        "codex usage limit reached - see gnhf.log",
        detail,
      )
    : new Error(detail);
}

export class CodexAgent implements Agent {
  name = "codex";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schemaPath: string;

  constructor(schemaPath: string, binOrDeps: string | CodexAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "codex";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schemaPath = schemaPath;
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
        buildCodexArgs(prompt, this.schemaPath, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCodexProcess(child, this.platform),
        )
      ) {
        return;
      }

      let lastAgentMessage: string | null = null;
      let lastStructuredError: string | null = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CodexEvent>(child.stdout!, logStream, (event) => {
        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed" && "usage" in event) {
          const u = (event as CodexTurnCompleted).usage;
          cumulative.inputTokens += u.input_tokens ?? 0;
          cumulative.outputTokens += u.output_tokens ?? 0;
          cumulative.cacheReadTokens += u.cached_input_tokens ?? 0;
          onUsage?.({ ...cumulative });
        }

        if (
          event.type === "error" &&
          "message" in event &&
          typeof (event as CodexErrorEvent).message === "string"
        ) {
          lastStructuredError = (event as CodexErrorEvent).message;
        }

        if (event.type === "turn.failed" && "error" in event) {
          const message = (event as CodexTurnFailed).error.message;
          if (typeof message === "string") {
            lastStructuredError = message;
          }
        }
      });

      setupChildProcessHandlers(
        child,
        "codex",
        logStream,
        reject,
        () => {
          if (!lastAgentMessage) {
            reject(new Error("codex returned no agent message"));
            return;
          }

          try {
            const output = JSON.parse(lastAgentMessage) as AgentOutput;
            resolve({ output, usage: cumulative });
          } catch (err) {
            reject(
              new Error(
                `Failed to parse codex output: ${err instanceof Error ? err.message : err}`,
              ),
            );
          }
        },
        (code, stderr) =>
          buildCodexExitError(code, stderr, lastStructuredError),
      );
    });
  }
}
