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
import {
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

const DEFAULT_MAX_TURNS = 30;

const COMMANDCODE_SUBCOMMANDS = new Set([
  "info",
  "status",
  "help",
  "whoami",
  "update",
  "feedback",
  "taste",
  "learn-taste",
  "mcp",
  "skills",
  "login",
  "logout",
]);

interface CommandCodeAgentDeps {
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

function terminateCommandCodeProcess(
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

function userSpecifiedPermissionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--yolo" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--auto-accept" ||
      arg === "--plan",
  );
}

function userSpecifiedTrustMode(userArgs: string[]): boolean {
  return userArgs.some((arg) => arg === "--trust" || arg === "-t");
}

function userSpecifiedOnboardingMode(userArgs: string[]): boolean {
  return userArgs.some((arg) => arg === "--skip-onboarding");
}

function userSpecifiedMaxTurns(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) => arg === "--max-turns" || arg.startsWith("--max-turns="),
  );
}

function buildCommandCodePrompt(
  prompt: string,
  schema: AgentOutputSchema,
): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Return only the JSON object in the final answer. Do not wrap it in Markdown. Do not include explanatory prose outside the JSON object.`;
}

export function buildCommandCodeArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    ...(userSpecifiedTrustMode(userArgs) ? [] : ["--trust"]),
    ...(userSpecifiedOnboardingMode(userArgs) ? [] : ["--skip-onboarding"]),
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--yolo"]),
    ...(userSpecifiedMaxTurns(userArgs)
      ? []
      : ["--max-turns", String(DEFAULT_MAX_TURNS)]),
    "-p",
    buildCommandCodePrompt(prompt, schema),
  ];
}

function parseCommandCodeOutput(
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
    "commandcode output did not contain a parseable JSON object",
  );
}

function isPermanentCommandCodeError(stderr: string): boolean {
  return (
    /not logged in/i.test(stderr) ||
    /authentication required/i.test(stderr) ||
    /invalid api key/i.test(stderr) ||
    /run\s+`?cmd login`?/i.test(stderr)
  );
}

function isMissingCommandCodeBinary(error: Error): boolean {
  return (
    ("code" in error && error.code === "ENOENT") || /ENOENT/.test(error.message)
  );
}

function createCommandCodeExitError(
  code: number | null,
  stderr: string,
): Error {
  if (code === 8) {
    return new Error(
      `commandcode hit --max-turns before completion: ${stderr.trim()}`,
    );
  }
  if (isPermanentCommandCodeError(stderr)) {
    const detail = stderr.trim();
    return new PermanentAgentError("commandcode authentication failed", detail);
  }
  return new Error(`commandcode exited with code ${code}: ${stderr.trim()}`);
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export class CommandCodeAgent implements Agent {
  name = "commandcode";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | CommandCodeAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "command-code";
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
    const { onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(
        this.bin,
        buildCommandCodeArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          detached: this.platform !== "win32",
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCommandCodeProcess(child, this.platform),
        )
      ) {
        return;
      }

      let stdout = "";

      child.stdout!.on("data", (data: Buffer) => {
        logStream?.write(data);
        const chunk = data.toString();
        stdout += chunk;
        const visible = chunk.trim();
        if (visible) onMessage?.(visible);
      });

      setupChildProcessHandlers(
        child,
        "commandcode",
        logStream,
        (err) => {
          if (isMissingCommandCodeBinary(err)) {
            const detail = `Failed to spawn commandcode: ${this.bin} not found on PATH`;
            reject(
              new PermanentAgentError(
                "command-code executable was not found - install Command Code or configure agentPathOverride.commandcode",
                detail,
              ),
            );
            return;
          }
          reject(err);
        },
        () => {
          if (!stdout.trim()) {
            reject(new Error("commandcode returned no output"));
            return;
          }

          try {
            const output = parseCommandCodeOutput(stdout, this.schema);
            resolve({ output, usage: ZERO_USAGE });
          } catch (err) {
            reject(
              new Error(
                `Failed to parse commandcode output: ${err instanceof Error ? err.message : err}`,
              ),
            );
          }
        },
        createCommandCodeExitError,
      );
    });
  }
}

export function isReservedCommandCodeArg(arg: string): boolean {
  return (
    arg === "-p" ||
    arg === "--print" ||
    arg.startsWith("--print=") ||
    arg === "--trust" ||
    arg === "-t" ||
    arg.startsWith("--trust=") ||
    arg === "--skip-onboarding" ||
    arg === "--resume" ||
    arg === "-r" ||
    arg.startsWith("--resume=") ||
    arg === "--continue" ||
    arg === "-c" ||
    arg === "--yolo" ||
    arg === "--dangerously-skip-permissions" ||
    arg === "--permission-mode" ||
    arg.startsWith("--permission-mode=") ||
    arg === "--auto-accept" ||
    arg === "--plan" ||
    arg === "--version" ||
    arg === "-v" ||
    arg === "--help" ||
    arg === "-h" ||
    COMMANDCODE_SUBCOMMANDS.has(arg)
  );
}
