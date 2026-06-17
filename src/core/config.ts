import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { CommitMessageConfig } from "./commit-message.js";
import { normalizeCommitMessageConfig } from "./commit-message-config.js";
import { InvalidConfigError } from "./config-errors.js";

export const AGENT_NAMES = [
  "claude",
  "codex",
  "rovodev",
  "opencode",
  "copilot",
  "cursor",
  "pi",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

// Agents reached via the bundled acpx runtime: built-in target names,
// configured registry names, or raw custom ACP server commands. Always
// written as "acp:<target-or-command>" so the prefix routes to AcpAgent.
export type AcpAgentSpec = `acp:${string}`;

export type AgentSpec = AgentName | AcpAgentSpec;

export function isAgentName(name: unknown): name is AgentName {
  return (
    typeof name === "string" &&
    (AGENT_NAMES as readonly string[]).includes(name)
  );
}

function hasDisallowedAcpTargetChar(target: string): boolean {
  for (let i = 0; i < target.length; i += 1) {
    const code = target.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isAcpSpec(spec: unknown): spec is AcpAgentSpec {
  if (typeof spec !== "string") return false;
  if (!spec.startsWith("acp:")) return false;
  const target = spec.slice("acp:".length);
  return (
    target.length > 0 &&
    target.trim() === target &&
    !hasDisallowedAcpTargetChar(target)
  );
}

export function isAgentSpec(spec: unknown): spec is AgentSpec {
  return isAgentName(spec) || isAcpSpec(spec);
}

export function getAcpTarget(spec: AcpAgentSpec): string {
  return spec.slice("acp:".length);
}

export function isNamedAcpTarget(target: string): boolean {
  return ACP_TARGET_NAME_PATTERN.test(target);
}

export function redactAcpTargetForLogs(target: string): string {
  return isNamedAcpTarget(target) ? target : "custom";
}

export function redactAgentSpecForLogs(spec: string): string {
  if (!spec.startsWith("acp:")) return spec;
  return `acp:${redactAcpTargetForLogs(spec.slice("acp:".length))}`;
}

export interface Config {
  agent: AgentSpec;
  agentPathOverride: Partial<Record<AgentName, string>>;
  agentArgsOverride: Partial<Record<AgentName, string[]>>;
  acpRegistryOverrides: Record<string, string>;
  commitMessage?: CommitMessageConfig;
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
  agentPathOverride: {},
  agentArgsOverride: {},
  acpRegistryOverrides: {},
  maxConsecutiveFailures: 3,
  preventSleep: true,
};

const ACP_TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CURSOR_RESERVED_SUBCOMMANDS = new Set([
  "about",
  "acp",
  "agent",
  "create-chat",
  "generate-rule",
  "help",
  "install-shell-integration",
  "login",
  "logout",
  "ls",
  "mcp",
  "models",
  "resume",
  "rule",
  "status",
  "tunnel",
  "uninstall-shell-integration",
  "update",
  "whoami",
  "worker",
]);
const CURSOR_VALUE_ARGS = new Set([
  "--endpoint",
  "-e",
  "--header",
  "-H",
  "--model",
  "--mode",
  "--plugin-dir",
  "--sandbox",
]);
const CURSOR_INLINE_VALUE_ARGS = [
  "--endpoint=",
  "--header=",
  "--model=",
  "--mode=",
  "--plugin-dir=",
  "--sandbox=",
] as const;
const CURSOR_RESERVED_SHORT_ARG_PREFIXES = ["-v", "-h", "-p", "-w"] as const;
const CURSOR_WORKER_ONLY_ARGS = [
  "--auth-token-file",
  "--data-dir",
  "--idle-release-timeout",
  "--label",
  "--labels-file",
  "--management-addr",
  "--name",
  "--pool",
  "--pool-name",
  "--single-use",
  "--worker-dir",
  "--debug",
  "--json",
  "--verbose",
] as const;
const CURSOR_EDITOR_ONLY_ARGS = [
  "--add",
  "--add-mcp",
  "--category",
  "--chat",
  "--classic",
  "--diff",
  "--disable-chromium-sandbox",
  "--disable-extension",
  "--disable-extensions",
  "--disable-gpu",
  "--disable-lcd-text",
  "--enable-proposed-api",
  "--extensions-dir",
  "--glass",
  "--goto",
  "--inspect-brk-extensions",
  "--inspect-extensions",
  "--install-extension",
  "--list-extensions",
  "--locate-shell-integration-path",
  "--locale",
  "--log",
  "--merge",
  "--mcp-workspace",
  "--new-window",
  "--pre-release",
  "--prof-startup",
  "--profile",
  "--remove",
  "--reuse-window",
  "--show-versions",
  "--status",
  "--suppress-popups-on-startup",
  "--sync",
  "--telemetry",
  "--uninstall-extension",
  "--update-extensions",
  "--user-data-dir",
  "--wait",
  "--web-worker-exthost",
] as const;
const CURSOR_BOOLEAN_ARGS = [
  "--approve-mcps",
  "--force",
  "--insecure",
  "--plan",
  "--yolo",
] as const;
const CURSOR_MANAGED_NEGATED_ARGS = new Set([
  "--no-api-key",
  "--no-auth-token",
  "--no-auth-token-file",
  "--no-continue",
  "--no-data-dir",
  "--no-debug",
  "--no-format",
  "--no-idle-release-timeout",
  "--no-json",
  "--no-label",
  "--no-labels-file",
  "--no-list-models",
  "--no-management-addr",
  "--no-name",
  "--no-output-format",
  "--no-pool",
  "--no-pool-name",
  "--no-print",
  "--no-resume",
  "--no-single-use",
  "--no-skip-worktree-setup",
  "--no-stream-partial-output",
  "--no-trust",
  "--no-verbose",
  "--no-worker-dir",
  "--no-workspace",
  "--no-worktree",
  "--no-worktree-base",
]);
const CURSOR_VALUE_ARG_CHOICES: Record<string, readonly string[]> = {
  "--mode": ["plan", "ask"],
  "--sandbox": ["enabled", "disabled"],
};
const CURSOR_EDITOR_ONLY_SHORT_ARG_PREFIXES = [
  "-a",
  "-d",
  "-g",
  "-m",
  "-n",
  "-r",
  "-s",
] as const;

function isCursorReservedShortArg(arg: string): boolean {
  return CURSOR_RESERVED_SHORT_ARG_PREFIXES.some(
    (prefix) => arg.startsWith(prefix) && !arg.startsWith("--"),
  );
}

function isCursorMalformedShortForceArg(arg: string): boolean {
  return arg.startsWith("-f") && arg !== "-f" && !arg.startsWith("--");
}

function isCursorMalformedShortInsecureArg(arg: string): boolean {
  return arg.startsWith("-k") && arg !== "-k" && !arg.startsWith("--");
}

function isCursorAttachedShortEndpointArg(arg: string): boolean {
  return arg.startsWith("-e") && arg !== "-e" && !arg.startsWith("--");
}

function isCursorBooleanArgWithValue(arg: string): boolean {
  return CURSOR_BOOLEAN_ARGS.some((flag) => arg.startsWith(`${flag}=`));
}

function isCursorNegatedBooleanArg(arg: string): boolean {
  return CURSOR_BOOLEAN_ARGS.some(
    (flag) =>
      arg === `--no-${flag.slice("--".length)}` ||
      arg.startsWith(`--no-${flag.slice("--".length)}=`),
  );
}

function isCursorNegatedValueArg(arg: string): boolean {
  return [...CURSOR_VALUE_ARGS].some((flag) => {
    if (!flag.startsWith("--")) return false;
    const negated = `--no-${flag.slice("--".length)}`;
    return arg === negated || arg.startsWith(`${negated}=`);
  });
}

function isCursorAttachedShortHeaderArg(arg: string): boolean {
  return arg.startsWith("-H") && arg !== "-H" && !arg.startsWith("--");
}

function isCursorManagedNegatedArg(arg: string): boolean {
  for (const flag of CURSOR_MANAGED_NEGATED_ARGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
  }
  return false;
}

function isCursorWorkerOnlyArg(arg: string): boolean {
  return CURSOR_WORKER_ONLY_ARGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

function isCursorEditorOnlyArg(arg: string): boolean {
  return (
    CURSOR_EDITOR_ONLY_ARGS.some((flag) => {
      const negated = `--no-${flag.slice("--".length)}`;
      return (
        arg === flag ||
        arg.startsWith(`${flag}=`) ||
        arg === negated ||
        arg.startsWith(`${negated}=`)
      );
    }) ||
    CURSOR_EDITOR_ONLY_SHORT_ARG_PREFIXES.some(
      (prefix) => arg.startsWith(prefix) && !arg.startsWith("--"),
    )
  );
}

function validateCursorValueChoice(
  flag: string,
  value: string,
  label: string,
  index: number,
): void {
  const choices = CURSOR_VALUE_ARG_CHOICES[flag];
  if (choices === undefined || choices.includes(value)) return;

  throw new InvalidConfigError(
    `Invalid config value for ${label}[${index}]: "${flag}" must be one of ${choices.map((choice) => `"${choice}"`).join(", ")}, got "${value}"`,
  );
}

function validateCursorHeaderValue(
  flag: string,
  value: string,
  label: string,
  index: number,
): void {
  if (flag !== "--header" && flag !== "-H") return;

  const colonIndex = value.indexOf(":");
  const headerName = value.slice(0, colonIndex);
  if (
    colonIndex <= 0 ||
    headerName === "" ||
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName) ||
    value.slice(colonIndex + 1).trim() === ""
  ) {
    throw new InvalidConfigError(
      `Invalid config value for ${label}[${index}]: "${flag}" value must use "Name: Value" header format with a valid header name`,
    );
  }
}

function formatAgentNameList(): string {
  const quoted = AGENT_NAMES.map((name) => `"${name}"`);
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function normalizePreventSleep(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function isReservedAgentArg(agent: AgentName, arg: string): boolean {
  switch (agent) {
    case "claude":
      return (
        arg === "-p" ||
        arg === "--print" ||
        arg === "--verbose" ||
        arg === "--output-format" ||
        arg.startsWith("--output-format=") ||
        arg === "--json-schema" ||
        arg.startsWith("--json-schema=")
      );
    case "codex":
      return (
        arg === "exec" ||
        arg === "--json" ||
        arg === "--output-schema" ||
        arg.startsWith("--output-schema=") ||
        arg === "--color" ||
        arg.startsWith("--color=")
      );
    case "opencode":
      return (
        arg === "serve" ||
        arg === "--hostname" ||
        arg.startsWith("--hostname=") ||
        arg === "--port" ||
        arg.startsWith("--port=") ||
        arg === "--print-logs"
      );
    case "rovodev":
      return (
        arg === "rovodev" ||
        arg === "serve" ||
        arg === "--disable-session-token"
      );
    case "copilot":
      return (
        arg === "-p" ||
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "-i" ||
        arg === "--interactive" ||
        arg.startsWith("--interactive=") ||
        arg === "-s" ||
        arg === "--silent" ||
        arg === "--output-format" ||
        arg.startsWith("--output-format=") ||
        arg === "--stream" ||
        arg.startsWith("--stream=") ||
        arg === "--no-color" ||
        arg === "--share" ||
        arg.startsWith("--share=") ||
        arg === "--share-gist"
      );
    case "cursor":
      return (
        CURSOR_RESERVED_SUBCOMMANDS.has(arg) ||
        isCursorReservedShortArg(arg) ||
        arg === "--version" ||
        arg.startsWith("--version=") ||
        arg === "--help" ||
        arg.startsWith("--help=") ||
        arg === "--" ||
        arg === "--print" ||
        arg.startsWith("--print=") ||
        arg === "--output-format" ||
        arg.startsWith("--output-format=") ||
        arg === "--stream-partial-output" ||
        arg.startsWith("--stream-partial-output=") ||
        arg === "--trust" ||
        arg.startsWith("--trust=") ||
        arg === "--api-key" ||
        arg.startsWith("--api-key=") ||
        arg === "--auth-token" ||
        arg.startsWith("--auth-token=") ||
        arg === "--workspace" ||
        arg.startsWith("--workspace=") ||
        arg === "--worktree" ||
        arg.startsWith("--worktree=") ||
        arg === "--worktree-base" ||
        arg.startsWith("--worktree-base=") ||
        arg === "--skip-worktree-setup" ||
        arg.startsWith("--skip-worktree-setup=") ||
        isCursorWorkerOnlyArg(arg) ||
        isCursorEditorOnlyArg(arg) ||
        arg === "--resume" ||
        arg.startsWith("--resume=") ||
        arg === "--continue" ||
        arg.startsWith("--continue=") ||
        arg === "--list-models" ||
        arg.startsWith("--list-models=") ||
        arg === "--format" ||
        arg.startsWith("--format=") ||
        isCursorManagedNegatedArg(arg)
      );
    case "pi":
      return (
        arg === "--mode" ||
        arg.startsWith("--mode=") ||
        arg === "--print" ||
        arg === "-p" ||
        arg === "--continue" ||
        arg === "-c" ||
        arg === "--resume" ||
        arg === "-r" ||
        arg === "--session" ||
        arg.startsWith("--session=") ||
        arg === "--fork" ||
        arg.startsWith("--fork=") ||
        arg === "--session-dir" ||
        arg.startsWith("--session-dir=") ||
        arg === "--no-session" ||
        arg === "--export" ||
        arg.startsWith("--export=") ||
        arg === "--list-models" ||
        arg.startsWith("--list-models=") ||
        arg === "--help" ||
        arg === "-h" ||
        arg === "--version" ||
        arg === "-v" ||
        arg === "--api-key" ||
        arg.startsWith("--api-key=")
      );
  }
}

function validateCursorArgValues(args: string[], label: string): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (isCursorMalformedShortForceArg(arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is not supported by Cursor; use the bare "-f" flag`,
      );
    }
    if (isCursorMalformedShortInsecureArg(arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is not supported by Cursor; use the bare "-k" flag`,
      );
    }
    if (isCursorBooleanArgWithValue(arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is not supported by Cursor; use the bare flag without a value`,
      );
    }
    if (isCursorNegatedBooleanArg(arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is not supported by Cursor; use the bare positive flag form`,
      );
    }
    if (isCursorNegatedValueArg(arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is not supported by Cursor; use the positive value flag form`,
      );
    }
    if (isCursorAttachedShortHeaderArg(arg)) {
      const value = arg.startsWith("-H=") ? arg.slice(3) : arg.slice(2);
      validateCursorHeaderValue("-H", value, label, index);
      continue;
    }
    if (isCursorAttachedShortEndpointArg(arg)) {
      const value = arg.startsWith("-e=") ? arg.slice(3) : arg.slice(2);
      if (value === "") {
        throw new InvalidConfigError(
          `Invalid config value for ${label}[${index}]: "${arg}" requires a non-empty value`,
        );
      }
      continue;
    }

    const inlinePrefix = CURSOR_INLINE_VALUE_ARGS.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix !== undefined && arg.slice(inlinePrefix.length) === "") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" requires a non-empty value`,
      );
    }
    if (inlinePrefix !== undefined) {
      validateCursorHeaderValue(
        inlinePrefix.slice(0, -1),
        arg.slice(inlinePrefix.length),
        label,
        index,
      );
      validateCursorValueChoice(
        inlinePrefix.slice(0, -1),
        arg.slice(inlinePrefix.length),
        label,
        index,
      );
    }

    if (isReservedAgentArg("cursor", arg)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" is managed by gnhf and cannot be overridden`,
      );
    }

    if (!CURSOR_VALUE_ARGS.has(arg)) {
      if (!arg.startsWith("-")) {
        throw new InvalidConfigError(
          `Invalid config value for ${label}[${index}]: "${arg}" would be treated as Cursor prompt text; gnhf supplies the prompt`,
        );
      }
      continue;
    }

    const next = args[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${arg}" requires a following value`,
      );
    }
    validateCursorHeaderValue(arg, next, label, index);
    validateCursorValueChoice(arg, next, label, index);
    index += 1;
  }
}

function validateAgentExtraArgs(
  agent: AgentName,
  args: string[],
  label: string,
): void {
  if (agent === "cursor") {
    validateCursorArgValues(args, label);
  }
}

/**
 * Resolve a user-supplied path against the config directory (~/.gnhf).
 * Expands leading `~` or `~/` to the home directory, then resolves relative
 * paths against `baseDir` so that entries like `./bin/codex` work predictably
 * regardless of the repo's cwd. Bare executable names and absolute paths pass
 * through unchanged.
 */
function resolveConfigPath(raw: string, baseDir: string): string {
  if (
    raw !== "~" &&
    !raw.startsWith("~/") &&
    !raw.startsWith("~\\") &&
    !raw.includes("/") &&
    !raw.includes("\\")
  ) {
    return raw;
  }

  const home = homedir();
  let expanded = raw;
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(home, expanded.slice(2));
  }
  return resolve(baseDir, expanded);
}

function normalizeAgentPathOverride(
  value: unknown,
  configDir: string,
): Partial<Record<AgentName, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentPathOverride: expected an object mapping agent names to paths`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string>> = {};

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        `Invalid agent name in agentPathOverride: "${key}". Use ${formatAgentNameList()}.`,
      );
    }
    if (typeof val !== "string") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a string`,
      );
    }
    if (val.trim() === "") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a non-empty string`,
      );
    }
    result[key as AgentName] = resolveConfigPath(val, configDir);
  }

  return result;
}

function normalizeAgentExtraArgs(
  value: unknown,
  label: string,
  agent: AgentName,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected an array of strings`,
    );
  }

  const args = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a string`,
      );
    }

    const trimmed = entry.trim();
    if (trimmed === "") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a non-empty string`,
      );
    }

    return trimmed;
  });

  if (agent !== "cursor") {
    args.forEach((arg, index) => {
      if (isReservedAgentArg(agent, arg)) {
        throw new InvalidConfigError(
          `Invalid config value for ${label}[${index}]: "${arg}" is managed by gnhf and cannot be overridden`,
        );
      }
    });
  }

  validateAgentExtraArgs(agent, args, label);
  return args;
}

function normalizeAgentArgsOverride(
  value: unknown,
): Partial<Record<AgentName, string[]>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentArgsOverride: expected an object`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string[]>> = {};

  for (const [key, rawConfig] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        `Invalid agent name in agentArgsOverride: "${key}". Use ${formatAgentNameList()}.`,
      );
    }
    const args = normalizeAgentExtraArgs(
      rawConfig,
      `agentArgsOverride.${key}`,
      key as AgentName,
    );
    if (args !== undefined) {
      result[key as AgentName] = args;
    }
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeAcpRegistryOverrides(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for acpRegistryOverrides: expected an object mapping ACP target names to commands`,
    );
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!ACP_TARGET_NAME_PATTERN.test(key)) {
      throw new InvalidConfigError(
        `Invalid target name in acpRegistryOverrides: "${key}". Target names must start with a letter or digit and contain only letters, digits, dots, underscores, colons, or hyphens.`,
      );
    }
    if (typeof val !== "string") {
      throw new InvalidConfigError(
        `Invalid command for acpRegistryOverrides.${key}: expected a string`,
      );
    }
    if (val.trim() === "") {
      throw new InvalidConfigError(
        `Invalid command for acpRegistryOverrides.${key}: expected a non-empty string`,
      );
    }
    result[key] = val.trim();
  }

  return result;
}

function normalizeConfig(
  config: Partial<Config>,
  configDir?: string,
): Partial<Config> {
  const normalized: Partial<Config> = { ...config };
  const hasPreventSleep = Object.prototype.hasOwnProperty.call(
    config,
    "preventSleep",
  );
  const preventSleep = normalizePreventSleep(config.preventSleep);

  if (preventSleep === undefined) {
    if (hasPreventSleep && config.preventSleep !== undefined) {
      throw new InvalidConfigError(
        `Invalid config value for preventSleep: ${String(config.preventSleep)}`,
      );
    }
    delete normalized.preventSleep;
  } else {
    normalized.preventSleep = preventSleep;
  }

  const hasAgentPathOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentPathOverride",
  );
  if (hasAgentPathOverride) {
    const resolveDir = configDir ?? join(homedir(), ".gnhf");
    const agentPathOverride = normalizeAgentPathOverride(
      config.agentPathOverride,
      resolveDir,
    );
    if (agentPathOverride === undefined) {
      delete normalized.agentPathOverride;
    } else {
      normalized.agentPathOverride = agentPathOverride;
    }
  } else {
    delete normalized.agentPathOverride;
  }

  const hasAgentArgsOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentArgsOverride",
  );
  if (hasAgentArgsOverride) {
    const agentArgsOverride = normalizeAgentArgsOverride(
      config.agentArgsOverride,
    );
    if (agentArgsOverride === undefined) {
      delete normalized.agentArgsOverride;
    } else {
      normalized.agentArgsOverride = agentArgsOverride;
    }
  } else {
    delete normalized.agentArgsOverride;
  }

  const hasAcpRegistryOverrides = Object.prototype.hasOwnProperty.call(
    config,
    "acpRegistryOverrides",
  );
  if (hasAcpRegistryOverrides) {
    const acpRegistryOverrides = normalizeAcpRegistryOverrides(
      config.acpRegistryOverrides,
    );
    if (acpRegistryOverrides === undefined) {
      delete normalized.acpRegistryOverrides;
    } else {
      normalized.acpRegistryOverrides = acpRegistryOverrides;
    }
  } else {
    delete normalized.acpRegistryOverrides;
  }

  const hasCommitMessage = Object.prototype.hasOwnProperty.call(
    config,
    "commitMessage",
  );
  if (hasCommitMessage) {
    const commitMessage = normalizeCommitMessageConfig(config.commitMessage);
    if (commitMessage === undefined) {
      delete normalized.commitMessage;
    } else {
      normalized.commitMessage = commitMessage;
    }
  } else {
    delete normalized.commitMessage;
  }

  return normalized;
}

function isMissingConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return "code" in error
    ? error.code === "ENOENT"
    : error.message.includes("ENOENT");
}

function serializeAgentPathOverride(
  agentPathOverride: Partial<Record<AgentName, string>>,
): string {
  const serializedOverrides = Object.fromEntries(
    AGENT_NAMES.flatMap((name) => {
      const value = agentPathOverride[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

  if (Object.keys(serializedOverrides).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentPathOverride: serializedOverrides },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeAgentArgsOverride(
  agentArgsOverride: Partial<Record<AgentName, string[]>>,
): string {
  if (Object.keys(agentArgsOverride).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentArgsOverride },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeAgent(agent: AgentSpec): string {
  return yaml
    .dump({ agent }, { lineWidth: -1, noRefs: true, sortKeys: false })
    .trimEnd();
}

function serializeConfig(config: Config): string {
  const agentPathOverrideSection = serializeAgentPathOverride(
    config.agentPathOverride,
  );
  const agentArgsOverrideSection = serializeAgentArgsOverride(
    config.agentArgsOverride,
  );
  const lines = [
    "# Agent to use by default: native agent name or acp:<target-or-command>",
    serializeAgent(config.agent),
    "",
    "# Custom paths to native agent binaries (optional)",
    "# Paths may be absolute, bare executable names on PATH,",
    "# ~-prefixed, or relative to this config directory.",
    "# Note: rovodev overrides must point to an acli-compatible binary.",
    "# agentPathOverride:",
    "#   claude: /path/to/custom-claude",
    "#   codex: /path/to/custom-codex",
    "#   copilot: /path/to/custom-copilot",
    "#   cursor: /path/to/custom-cursor",
    "#   pi: /path/to/custom-pi",
    "",
    "# Native agent CLI arg overrides (optional)",
    "# ACP targets do not support path or arg overrides.",
    "# agentArgsOverride:",
    "#   codex:",
    "#     - -m",
    "#     - gpt-5.4",
    "#     - -c",
    '#     - model_reasoning_effort="high"',
    "#     - --full-auto",
    "#   copilot:",
    "#     - --model",
    "#     - gpt-5.4",
    "#   cursor:",
    "#     - --model",
    "#     - gpt-5",
    "#   pi:",
    "#     - --provider",
    "#     - openai-codex",
    "#     - --model",
    "#     - gpt-5.5",
    "#     - --thinking",
    "#     - high",
    "",
    "# Custom ACP target commands (optional)",
    "# Maps acp:<target> names to spawn commands. Useful for naming a",
    "# local or beta build of an ACP agent.",
    "# acpRegistryOverrides:",
    '#   my-fork: "/usr/local/bin/my-claude-code-fork --acp"',
    '#   staging: "node /opt/staging/agent.mjs"',
    "",
    "# Commit message convention (optional)",
    "# Defaults to: gnhf <iteration>: <summary>",
    "# Use Conventional Commits semantic-release headers:",
    "# commitMessage:",
    "#   preset: conventional",
  ];

  if (agentPathOverrideSection) {
    lines.push(...agentPathOverrideSection.split("\n"));
  }

  if (agentArgsOverrideSection) {
    lines.push(...agentArgsOverrideSection.split("\n"));
  }

  lines.push(
    "",
    "# Abort after this many consecutive failures",
    `maxConsecutiveFailures: ${config.maxConsecutiveFailures}`,
    "",
    "# Prevent the machine from sleeping during a run",
    `preventSleep: ${config.preventSleep}`,
    "",
  );

  return lines.join("\n");
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configDir = join(homedir(), ".gnhf");
  const configPath = join(configDir, "config.yml");
  let fileConfig: Partial<Config> = {};
  let shouldBootstrapConfig = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = normalizeConfig(
      (yaml.load(raw) as Partial<Config>) ?? {},
      configDir,
    );
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw error;
    }
    if (isMissingConfigError(error)) {
      shouldBootstrapConfig = true;
    }

    // Config file doesn't exist or is invalid -- use defaults
  }

  const resolvedConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...normalizeConfig(overrides ?? {}),
  };

  if (shouldBootstrapConfig) {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, serializeConfig(resolvedConfig), "utf-8");
    } catch {
      // Best-effort only. Startup should still fall back to in-memory defaults.
    }
  }

  return resolvedConfig;
}
