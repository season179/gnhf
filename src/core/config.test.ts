import { describe, it, expect, vi, beforeEach } from "vitest";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAgentSpec, loadConfig } from "./config.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

const HOME = "/mock-home";
const CONFIG_DIR = join(HOME, ".gnhf");
const CONFIG_PATH = join(CONFIG_DIR, "config.yml");
const BOOTSTRAP_CONFIG_TEMPLATE = (agent: string) =>
  [
    "# Agent to use by default: native agent name or acp:<target-or-command>",
    `agent: ${agent}`,
    "",
    "# Custom paths to native agent binaries (optional)",
    "# Paths may be absolute, bare executable names on PATH,",
    "# ~-prefixed, or relative to this config directory.",
    "# Note: rovodev overrides must point to an acli-compatible binary.",
    "# agentPathOverride:",
    "#   claude: /path/to/custom-claude",
    "#   codex: /path/to/custom-codex",
    "#   commandcode: /path/to/custom-command-code",
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
    "#   commandcode:",
    "#     - --model",
    "#     - claude-sonnet-4-6",
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
    "",
    "# Abort after this many consecutive failures",
    "maxConsecutiveFailures: 3",
    "",
    "# Prevent the machine from sleeping during a run",
    "preventSleep: true",
    "",
  ].join("\n");

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadConfig();

    expect(mockMkdirSync).toHaveBeenCalledWith(CONFIG_DIR, {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      BOOTSTRAP_CONFIG_TEMPLATE("claude"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).not.toHaveProperty("commitMessage");
  });

  it("still returns defaults when default config creation fails", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("writes override values when bootstrapping a missing config file", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "codex" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      BOOTSTRAP_CONFIG_TEMPLATE("codex"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("YAML-quotes raw ACP command specs when bootstrapping", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const agent = "acp:./bin/dev-acp --profile ci # local";

    loadConfig({ agent });

    const written = mockWriteFileSync.mock.calls[0]?.[1];
    expect(typeof written).toBe("string");
    expect((yaml.load(written as string) as { agent: string }).agent).toBe(
      agent,
    );
  });

  it("writes agentPathOverride values when bootstrapping a missing config file", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({
      agentPathOverride: {
        claude: "/usr/local/bin/claude-wrapper",
        codex: "./bin/codex-wrapper",
      },
    });

    const resolvedClaude = resolve("/usr/local/bin/claude-wrapper");
    const resolvedCodex = resolve(CONFIG_DIR, "bin", "codex-wrapper");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining(`claude: ${resolvedClaude}`),
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining(`codex: ${resolvedCodex}`),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {
        claude: resolvedClaude,
        codex: resolvedCodex,
      },
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads config from ~/.gnhf/config.yml", () => {
    mockReadFileSync.mockReturnValue("agent: codex\n");

    const config = loadConfig();

    expect(mockReadFileSync).toHaveBeenCalledWith(CONFIG_PATH, "utf-8");
    expect(config.agent).toBe("codex");
  });

  it("reads the conventional commit message preset from config", () => {
    mockReadFileSync.mockReturnValue(
      "commitMessage:\n  preset: conventional\n",
    );

    const config = loadConfig();

    expect(config.commitMessage).toEqual({
      preset: "conventional",
    });
  });

  it("merges file config with defaults", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 10\n");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 10,
      preventSleep: true,
    });
  });

  it('coerces quoted "false" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue('preventSleep: "false"\n');

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it('coerces "off" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue("preventSleep: off\n");

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it("overrides take precedence over file config and defaults", () => {
    mockReadFileSync.mockReturnValue(
      "agent: codex\nmaxConsecutiveFailures: 10\npreventSleep: false\n",
    );

    const config = loadConfig({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads per-agent extra args for all supported agents", () => {
    mockReadFileSync.mockReturnValue(
      [
        "agentArgsOverride:",
        "  claude:",
        "    - --model",
        "    - sonnet",
        "  codex:",
        "    - -m",
        "    - gpt-5.4",
        "  rovodev:",
        "    - --profile",
        "    - work",
        "  opencode:",
        "    - --model",
        "    - gpt-5",
        "  commandcode:",
        "    - --model",
        "    - claude-sonnet-4-6",
        "  copilot:",
        "    - --model",
        "    - gpt-5.4",
        "  cursor:",
        "    - --model",
        "    - gpt-5",
        "  pi:",
        "    - --provider",
        "    - openai-codex",
        "    - --model",
        "    - gpt-5.5",
        "    - --thinking",
        "    - high",
        "",
      ].join("\n"),
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--model", "sonnet"],
      codex: ["-m", "gpt-5.4"],
      rovodev: ["--profile", "work"],
      opencode: ["--model", "gpt-5"],
      commandcode: ["--model", "claude-sonnet-4-6"],
      copilot: ["--model", "gpt-5.4"],
      cursor: ["--model", "gpt-5"],
      pi: [
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.5",
        "--thinking",
        "high",
      ],
    });
  });

  it("handles empty config file gracefully", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("handles invalid YAML gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("invalid yaml");
    });

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("resolves ~ in agentPathOverride to the home directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: ~/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve(join(HOME, "bin", "my-claude")),
    );
  });

  it("resolves relative paths in agentPathOverride against the config directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  codex: ./bin/my-codex\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.codex).toBe(
      resolve(CONFIG_DIR, "bin", "my-codex"),
    );
  });

  it("passes absolute paths in agentPathOverride through unchanged", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: /usr/local/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve("/usr/local/bin/my-claude"),
    );
  });

  it("preserves bare executable names in agentPathOverride", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: claude-code-switch\n",
    );

    const config = loadConfig();

    expect(config.agentPathOverride.claude).toBe("claude-code-switch");
  });

  it("allows agentArgsOverride.claude to set the dangerous permission flag explicitly", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  claude:\n    - --dangerously-skip-permissions\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--dangerously-skip-permissions"],
    });
  });

  it("allows agentArgsOverride.cursor to set a permission mode explicitly", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  cursor:\n    - --yolo\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      cursor: ["--yolo"],
    });
  });

  it("allows agentArgsOverride.cursor to set the short force flag explicitly", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  cursor:\n    - -f\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      cursor: ["-f"],
    });
  });

  it("allows agentArgsOverride.cursor to pass value-taking flags with values", () => {
    mockReadFileSync.mockReturnValue(
      [
        "agentArgsOverride:",
        "  cursor:",
        "    - --endpoint",
        "    - https://api.cursor.test",
        "    - --model",
        "    - gpt-5",
        "    - -H",
        "    - 'X-Cursor-Mode: ci'",
        "    - --header",
        "    - 'Authorization: Bearer token'",
        "    - --plugin-dir",
        "    - ./plugins/cursor",
        "    - --plugin-dir",
        "    - agent",
        "    - '--header=Accept: application/json'",
        "    - --mode=ask",
        "    - --sandbox",
        "    - enabled",
        "    - --insecure",
        "    - -k",
        "    - --endpoint=https://api2.cursor.test",
        "    - -ehttps://api3.cursor.test",
        "    - -e=https://api4.cursor.test",
        "    - '-HX-Trace: enabled'",
        "    - '-H=X-Trace-Assign: enabled'",
        "",
      ].join("\n"),
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      cursor: [
        "--endpoint",
        "https://api.cursor.test",
        "--model",
        "gpt-5",
        "-H",
        "X-Cursor-Mode: ci",
        "--header",
        "Authorization: Bearer token",
        "--plugin-dir",
        "./plugins/cursor",
        "--plugin-dir",
        "agent",
        "--header=Accept: application/json",
        "--mode=ask",
        "--sandbox",
        "enabled",
        "--insecure",
        "-k",
        "--endpoint=https://api2.cursor.test",
        "-ehttps://api3.cursor.test",
        "-e=https://api4.cursor.test",
        "-HX-Trace: enabled",
        "-H=X-Trace-Assign: enabled",
      ],
    });
  });

  it.each([
    "--endpoint",
    "-e",
    "--model",
    "--header",
    "-H",
    "--plugin-dir",
    "--mode",
    "--sandbox",
  ])(
    "throws when agentArgsOverride.cursor contains value flag %s without a value",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*requires a following value/,
      );
    },
  );

  it("throws when agentArgsOverride.cursor value flag would consume another flag", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  cursor:\n    - --header\n    - --model\n    - gpt-5\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.cursor\[0\].*requires a following value/,
    );
  });

  it("throws when agentArgsOverride.cursor contains an empty inline value", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  cursor:\n    - --endpoint=\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.cursor\[0\].*requires a non-empty value/,
    );
  });

  it.each([
    ["--mode", "write", /plan.*ask/],
    ["--mode=write", undefined, /plan.*ask/],
    ["--sandbox", "ask", /enabled.*disabled/],
    ["--sandbox=ask", undefined, /enabled.*disabled/],
  ])(
    "throws when agentArgsOverride.cursor contains unsupported value for %s",
    (flag, value, expected) => {
      const entries =
        value === undefined
          ? [`    - ${flag}`]
          : [`    - ${flag}`, `    - ${value}`];
      mockReadFileSync.mockReturnValue(
        ["agentArgsOverride:", "  cursor:", ...entries, ""].join("\n"),
      );

      expect(() => loadConfig()).toThrow(expected);
    },
  );

  it.each([
    ["--header", "Authorization", /Name: Value/],
    ["--header=Authorization", undefined, /Name: Value/],
    ["--header", "Bad Header: token", /valid header name/],
    ["--header", "Authorization : Bearer token", /valid header name/],
    ["'--header= Authorization: Bearer token'", undefined, /valid header name/],
    ["'--header==Authorization: Bearer token'", undefined, /valid header name/],
    ["-H", ": Bearer token", /Name: Value/],
    ["-H", "Authorization:   ", /Name: Value/],
    ["'-HBad Header: token'", undefined, /valid header name/],
    ["-HAuthorization", undefined, /Name: Value/],
    ["'-H=Bad Header: token'", undefined, /valid header name/],
  ])(
    "throws when agentArgsOverride.cursor contains malformed header value for %s",
    (flag, value, expected) => {
      const entries =
        value === undefined
          ? [`    - ${flag}`]
          : [`    - ${flag}`, `    - '${value}'`];
      mockReadFileSync.mockReturnValue(
        ["agentArgsOverride:", "  cursor:", ...entries, ""].join("\n"),
      );

      expect(() => loadConfig()).toThrow(expected);
    },
  );

  it("throws when agentArgsOverride.cursor contains positional prompt text", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  cursor:\n    - --approve-mcps\n    - write docs\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.cursor\[1\].*prompt text/,
    );
  });

  it.each(["-f=false", "-ffalse", "-k=false", "-kfalse"])(
    "throws when agentArgsOverride.cursor contains malformed short boolean flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*not supported by Cursor/,
      );
    },
  );

  it.each([
    "--approve-mcps=false",
    "--force=false",
    "--insecure=false",
    "--plan=false",
    "--yolo=false",
  ])(
    "throws when agentArgsOverride.cursor contains boolean assignment %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*bare flag/,
      );
    },
  );

  it.each([
    "--no-approve-mcps",
    "--no-approve-mcps=false",
    "--no-force",
    "--no-force=true",
    "--no-insecure",
    "--no-insecure=true",
    "--no-plan",
    "--no-plan=false",
    "--no-yolo",
    "--no-yolo=true",
  ])(
    "throws when agentArgsOverride.cursor contains negated boolean flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*bare positive flag form/,
      );
    },
  );

  it.each([
    "--no-header",
    "--no-header=true",
    "--no-endpoint",
    "--no-endpoint=https://api.cursor.test",
    "--no-model",
    "--no-model=gpt-5",
    "--no-mode",
    "--no-mode=plan",
    "--no-plugin-dir",
    "--no-plugin-dir=./plugins",
    "--no-sandbox",
    "--no-sandbox=enabled",
  ])(
    "throws when agentArgsOverride.cursor contains negated value flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*positive value flag form/,
      );
    },
  );

  it.each([
    "--workspace",
    "--workspace=/tmp/other-repo",
    "-w",
    "--worktree",
    "--worktree=feature",
    "--worktree-base",
    "--worktree-base=main",
    "--skip-worktree-setup",
    "--skip-worktree-setup=true",
    "--worker-dir",
    "--worker-dir=/tmp/project",
    "--auth-token-file",
    "--auth-token-file=/tmp/token",
    "--management-addr",
    "--management-addr=:8080",
    "--label",
    "--label=env=ci",
    "--labels-file",
    "--labels-file=/tmp/labels.json",
    "--idle-release-timeout",
    "--idle-release-timeout=60",
    "--pool",
    "--pool=true",
    "--single-use",
    "--single-use=true",
    "--pool-name",
    "--pool-name=default",
    "--name",
    "--name=ci-worker",
    "--data-dir",
    "--data-dir=/tmp/cursor",
    "--debug",
    "--debug=true",
    "--resume",
    "--resume=chat-id",
    "--continue",
    "--continue=true",
    "--list-models",
    "--list-models=true",
    "--format",
    "--format=json",
    "--no-format",
    "--no-format=json",
    "--json",
    "--json=true",
    "--verbose",
    "--verbose=true",
    "--chat",
    "--chat=true",
    "--log",
    "--log=info",
    "--mcp-workspace",
    "--mcp-workspace=true",
    "--user-data-dir",
    "--user-data-dir=/tmp/cursor-user",
    "--install-extension=publisher.name",
    "--sync=off",
    "--telemetry",
    "--no-chat",
    "--no-log=info",
    "--api-key",
    "--api-key=secret",
    "--no-api-key",
    "--auth-token",
    "--auth-token=secret",
    "--no-auth-token",
    "--no-auth-token=true",
    "--no-auth-token-file",
    "--no-continue",
    "--no-data-dir",
    "--no-debug",
    "--no-idle-release-timeout",
    "--no-json",
    "--no-label",
    "--no-labels-file",
    "--no-list-models",
    "--no-management-addr",
    "--no-mcp-workspace",
    "--no-name",
    "--no-output-format",
    "--no-pool",
    "--no-pool-name",
    "--no-print",
    "--no-resume",
    "--no-resume=true",
    "--no-single-use",
    "--no-skip-worktree-setup",
    "--no-stream-partial-output",
    "--no-trust",
    "--no-verbose",
    "--no-worker-dir",
    "--no-worker-dir=true",
    "--no-workspace",
    "--no-worktree",
    "--no-worktree-base",
    "--print=false",
    "--stream-partial-output=false",
    "--trust=false",
    "--",
    "-v",
    "-v=false",
    "-vfalse",
    "--version",
    "--version=true",
    "-h",
    "-h=false",
    "-hfalse",
    "--help",
    "--help=true",
    "-p=false",
    "-pfalse",
    "-w=feature",
    "-wfeature",
    "-s",
    "-s=false",
    "-n",
    "-nfalse",
    "-dfile",
    "-m=left",
    "about",
    "acp",
    "agent",
    "create-chat",
    "generate-rule",
    "help",
    "install-shell-integration",
    "ls",
    "login",
    "logout",
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
  ])(
    "throws when agentArgsOverride.cursor contains reserved flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  cursor:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.cursor\[0\].*managed by gnhf/,
      );
    },
  );

  it("allows safe agentArgsOverride.pi flags", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  pi:\n    - --provider\n    - openai-codex\n    - --model\n    - gpt-5.5\n    - --thinking\n    - high\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      pi: [
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.5",
        "--thinking",
        "high",
      ],
    });
  });

  it("allows safe agentArgsOverride.commandcode flags", () => {
    mockReadFileSync.mockReturnValue(
      'agentArgsOverride:\n  commandcode:\n    - --model\n    - claude-sonnet-4-6\n    - --max-turns\n    - "30"\n',
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      commandcode: ["--model", "claude-sonnet-4-6", "--max-turns", "30"],
    });
  });

  it.each([
    "-p",
    "--print",
    "-t",
    "--trust",
    "--skip-onboarding",
    "--yolo",
    "--dangerously-skip-permissions",
    "-r",
    "--resume",
    "--resume=chat-id",
    "-c",
    "--continue",
    "--list-models",
    "--ide-setup",
    "--learn-taste",
    "--permission-mode",
    "--auto-accept",
    "--plan",
    "login",
    "logout",
    "status",
  ])(
    "throws when agentArgsOverride.commandcode contains reserved flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  commandcode:\n    - ${flag}\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.commandcode\[0\].*managed by gnhf/,
      );
    },
  );

  it.each([
    "--mode",
    "--mode=json",
    "-p",
    "--session",
    "--no-session",
    "--api-key",
    "--api-key=secret",
  ])("throws when agentArgsOverride.pi contains reserved flag %s", (flag) => {
    mockReadFileSync.mockReturnValue(
      `agentArgsOverride:\n  pi:\n    - ${flag}\n`,
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.pi\[0\].*managed by gnhf/,
    );
  });

  it("reads acpRegistryOverrides from config", () => {
    mockReadFileSync.mockReturnValue(
      [
        "acpRegistryOverrides:",
        '  my-fork: "node /opt/my-acp-agent.mjs"',
        '  staging-claude: "claude-code-beta --acp"',
        "",
      ].join("\n"),
    );

    const config = loadConfig();

    expect(config.acpRegistryOverrides).toEqual({
      "my-fork": "node /opt/my-acp-agent.mjs",
      "staging-claude": "claude-code-beta --acp",
    });
  });

  it("defaults acpRegistryOverrides to an empty object", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();

    expect(config.acpRegistryOverrides).toEqual({});
  });

  it.each([
    {
      label: "non-object value",
      yaml: 'acpRegistryOverrides: "not-an-object"\n',
      expected: "Invalid config value for acpRegistryOverrides",
    },
    {
      label: "array value",
      yaml: "acpRegistryOverrides:\n  - foo\n",
      expected: "Invalid config value for acpRegistryOverrides",
    },
    {
      label: "non-string command",
      yaml: "acpRegistryOverrides:\n  foo: 42\n",
      expected: "Invalid command for acpRegistryOverrides.foo",
    },
    {
      label: "blank command",
      yaml: 'acpRegistryOverrides:\n  foo: "   "\n',
      expected: "Invalid command for acpRegistryOverrides.foo",
    },
    {
      label: "blank target name",
      yaml: 'acpRegistryOverrides:\n  "": "node x.mjs"\n',
      expected: "Invalid target name in acpRegistryOverrides",
    },
    {
      label: "target name with space",
      yaml: 'acpRegistryOverrides:\n  "bad name": "node x.mjs"\n',
      expected: "Invalid target name in acpRegistryOverrides",
    },
  ])("rejects invalid acpRegistryOverrides: $label", ({ yaml, expected }) => {
    mockReadFileSync.mockReturnValue(yaml);
    expect(() => loadConfig()).toThrow(expected);
  });
});

describe("isAgentSpec", () => {
  it("accepts raw ACP commands after the acp: prefix", () => {
    expect(isAgentSpec("acp:./bin/dev-acp --profile ci")).toBe(true);
    expect(isAgentSpec("acp:npx -y @scope/custom-agent acp")).toBe(true);
  });

  it("returns false for non-string values", () => {
    expect(isAgentSpec(42 as unknown as string)).toBe(false);
  });
});
