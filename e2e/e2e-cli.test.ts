import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCliPath = join(repoRoot, "dist", "cli.mjs");
const fixtureBinDir = join(repoRoot, "e2e", "fixtures");
const packageVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
).version as string;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [distCliPath, ...args], {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

class TempCleanup {
  private dirs: string[] = [];

  mkdir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `gnhf-e2e-cli-${prefix}-`));
    this.dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) {
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      } catch {
        // Windows: child processes may still hold file locks briefly after exit
      }
    }
  }
}

function createRepo(temp: TempCleanup): string {
  const cwd = temp.mkdir("repo");
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf tests"], cwd);
  git(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  git(["add", "README.md"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

function createHomeWithConfig(
  temp: TempCleanup,
  configYaml: string,
): NodeJS.ProcessEnv {
  const home = temp.mkdir("home");
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(join(home, ".gnhf", "config.yml"), configYaml, "utf-8");
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function createMockOpencodeEnv(
  temp: TempCleanup,
  configYaml: string,
): { env: NodeJS.ProcessEnv; mockLogPath: string } {
  const home = temp.mkdir("home");
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(join(home, ".gnhf", "config.yml"), configYaml, "utf-8");
  const logDir = temp.mkdir("logs");
  const mockLogPath = join(logDir, "mock-opencode.jsonl");
  return {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
    },
    mockLogPath,
  };
}

function createMockCursorEnv(
  temp: TempCleanup,
  configYaml: string,
): { env: NodeJS.ProcessEnv; mockLogPath: string } {
  const home = temp.mkdir("home");
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(join(home, ".gnhf", "config.yml"), configYaml, "utf-8");
  const logDir = temp.mkdir("logs");
  const mockLogPath = join(logDir, "mock-cursor.jsonl");
  return {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      GNHF_MOCK_CURSOR_LOG_PATH: mockLogPath,
    },
    mockLogPath,
  };
}

function createMockCommandCodeEnv(
  temp: TempCleanup,
  configYaml: string,
): { env: NodeJS.ProcessEnv; mockLogPath: string } {
  const home = temp.mkdir("home");
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(join(home, ".gnhf", "config.yml"), configYaml, "utf-8");
  const logDir = temp.mkdir("logs");
  const mockLogPath = join(logDir, "mock-commandcode.jsonl");
  return {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      GNHF_MOCK_COMMANDCODE_LOG_PATH: mockLogPath,
    },
    mockLogPath,
  };
}

async function withTemp<T>(fn: (temp: TempCleanup) => Promise<T>): Promise<T> {
  const temp = new TempCleanup();
  try {
    return await fn(temp);
  } finally {
    temp.cleanup();
  }
}

describe.concurrent("gnhf e2e cli", () => {
  it("prints the package version for -V", async () => {
    await withTemp(async (temp) => {
      const cwd = temp.mkdir("version");

      const result = await runCli(cwd, ["-V"]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(packageVersion);
    });
  }, 15_000);

  it("prints a friendly message outside a git repository", async () => {
    await withTemp(async (temp) => {
      const cwd = temp.mkdir("no-git");

      const result = await runCli(cwd, ["ship it", "--agent", "claude"]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        'gnhf: This command must be run inside a Git repository. Change into a repo or run "git init" first.',
      );
    });
  }, 15_000);

  it("exits with error when --worktree is used from a gnhf branch", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      git(["checkout", "-b", "gnhf/existing-run"], cwd);

      const result = await runCli(cwd, [
        "new objective",
        "--agent",
        "claude",
        "--worktree",
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "Cannot use --worktree from a gnhf branch",
      );
    });
  }, 15_000);

  it("uses config.agent when --agent flag is omitted", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockOpencodeEnv(
        temp,
        "agent: opencode\n",
      );

      const result = await runCli(
        cwd,
        ["ship it", "--max-iterations", "1"],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      const mockLog = readFileSync(mockLogPath, "utf-8");
      expect(mockLog).toContain('"event":"server:start"');
    });
  }, 30_000);

  it("runs Cursor through the native stream-json adapter", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockCursorEnv(
        temp,
        [
          "agent: cursor",
          "agentPathOverride:",
          "  cursor: cursor-mock",
          "agentArgsOverride:",
          "  cursor:",
          "    - --model",
          "    - gpt-5",
          "",
        ].join("\n"),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--max-iterations", "1"],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      expect(git(["log", "-1", "--pretty=%s"], cwd)).toBe(
        "gnhf 1: mock cursor completed",
      );
      expect(readFileSync(join(cwd, "README.md"), "utf-8")).toContain(
        "mock cursor change",
      );

      const [invokeLine] = readFileSync(mockLogPath, "utf-8")
        .trim()
        .split("\n");
      const invoke = JSON.parse(invokeLine!) as {
        event: string;
        args: string[];
        prompt: string;
      };
      expect(invoke.event).toBe("invoke");
      expect(invoke.args.at(-1)).toContain("ship it");
      expect(invoke.args).toEqual(
        expect.arrayContaining([
          "agent",
          "--model",
          "gpt-5",
          "-p",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--trust",
          "--force",
        ]),
      );
      expect(invoke.prompt).toContain("ship it");
      expect(invoke.prompt).toContain("gnhf final output contract");
    });
  }, 30_000);

  it("runs Command Code through the native print-mode adapter", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockCommandCodeEnv(
        temp,
        [
          "agent: commandcode",
          "agentPathOverride:",
          "  commandcode: commandcode-mock",
          "agentArgsOverride:",
          "  commandcode:",
          "    - --model",
          "    - claude-sonnet-4-6",
          "",
        ].join("\n"),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--max-iterations", "1"],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      expect(git(["log", "-1", "--pretty=%s"], cwd)).toBe(
        "gnhf 1: mock commandcode completed",
      );
      expect(readFileSync(join(cwd, "README.md"), "utf-8")).toContain(
        "mock commandcode change",
      );

      const [invokeLine] = readFileSync(mockLogPath, "utf-8")
        .trim()
        .split("\n");
      const invoke = JSON.parse(invokeLine!) as {
        event: string;
        args: string[];
        prompt: string;
      };
      expect(invoke.event).toBe("invoke");
      expect(invoke.args).toEqual(
        expect.arrayContaining([
          "--model",
          "claude-sonnet-4-6",
          "-p",
          "--trust",
          "--skip-onboarding",
          "--yolo",
          "--max-turns",
          "30",
        ]),
      );
      const printIndex = invoke.args.indexOf("-p");
      expect(printIndex).toBeGreaterThan(invoke.args.indexOf("--trust"));
      expect(printIndex).toBeGreaterThan(invoke.args.indexOf("--skip-onboarding"));
      expect(printIndex).toBeGreaterThan(invoke.args.indexOf("--yolo"));
      expect(printIndex).toBeGreaterThan(invoke.args.indexOf("--max-turns"));
      expect(invoke.prompt).toContain("ship it");
      expect(invoke.prompt).toContain("gnhf final output contract");
    });
  }, 30_000);

  it("passes -m model short flag through agentArgsOverride", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockCommandCodeEnv(
        temp,
        [
          "agent: commandcode",
          "agentPathOverride:",
          "  commandcode: commandcode-mock",
          "agentArgsOverride:",
          "  commandcode:",
          "    - -m",
          "    - claude-sonnet-4-6",
          "",
        ].join("\n"),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--max-iterations", "1"],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");

      const [invokeLine] = readFileSync(mockLogPath, "utf-8")
        .trim()
        .split("\n");
      const invoke = JSON.parse(invokeLine!) as {
        event: string;
        args: string[];
      };
      expect(invoke.event).toBe("invoke");
      expect(invoke.args).toEqual(
        expect.arrayContaining(["-m", "claude-sonnet-4-6"]),
      );
    });
  }, 30_000);

  it("uses conventional commit subjects when Command Code returns type and scope", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockCommandCodeEnv(
        temp,
        [
          "agent: commandcode",
          "agentPathOverride:",
          "  commandcode: commandcode-mock",
          "commitMessage:",
          "  preset: conventional",
          "",
        ].join("\n"),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--max-iterations", "1"],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      expect(git(["log", "-1", "--pretty=%s"], cwd)).toBe(
        "feat(commandcode): mock commandcode completed",
      );

      const [invokeLine] = readFileSync(mockLogPath, "utf-8")
        .trim()
        .split("\n");
      const invoke = JSON.parse(invokeLine!) as {
        event: string;
        prompt: string;
      };
      expect(invoke.prompt).toContain("type: Commit type");
      expect(invoke.prompt).toContain("scope: Optional commit scope");
    });
  }, 30_000);

  it("honors --stop-when when Command Code returns should_fully_stop", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const { env, mockLogPath } = createMockCommandCodeEnv(
        temp,
        [
          "agent: commandcode",
          "agentPathOverride:",
          "  commandcode: commandcode-mock",
          "",
        ].join("\n"),
      );

      const result = await runCli(
        cwd,
        [
          "ship it",
          "--stop-when",
          "task is done",
          "--max-iterations",
          "5",
        ],
        env,
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      expect(result.stdout.replace(/\x1b\[[0-9;]*m/g, "")).toContain(
        "stop condition met",
      );

      const [invokeLine] = readFileSync(mockLogPath, "utf-8")
        .trim()
        .split("\n");
      const invoke = JSON.parse(invokeLine!) as {
        event: string;
        prompt: string;
      };
      expect(invoke.prompt).toContain("should_fully_stop");
      expect(invoke.prompt).toContain("task is done");
    });
  }, 30_000);

  it.each([
    ["preset: gnhf", "commitMessage:\n  preset: gnhf\n"],
    ["preset: angular", "commitMessage:\n  preset: angular\n"],
    ["preset: semantic", "commitMessage:\n  preset: semantic\n"],
    ["empty object", "commitMessage: {}\n"],
  ])(
    "rejects invalid commitMessage config (%s)",
    async (_label, configYaml) => {
      await withTemp(async (temp) => {
        const cwd = createRepo(temp);
        const env = createHomeWithConfig(temp, configYaml);

        const result = await runCli(cwd, ["ship it", "--agent", "claude"], env);

        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(
          'Invalid config value for commitMessage.preset: expected "conventional"',
        );
      });
    },
    15_000,
  );

  it("rejects commitMessage with no value", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const env = createHomeWithConfig(temp, "commitMessage:\n");

      const result = await runCli(cwd, ["ship it", "--agent", "claude"], env);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "Invalid config value for commitMessage: expected an object",
      );
    });
  }, 15_000);

  it("rejects commitMessage config with template field", async () => {
    await withTemp(async (temp) => {
      const cwd = createRepo(temp);
      const env = createHomeWithConfig(
        temp,
        [
          "commitMessage:",
          "  preset: conventional",
          '  template: "{{type}}: {{summary}}"',
          "",
        ].join("\n"),
      );

      const result = await runCli(cwd, ["ship it", "--agent", "claude"], env);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "Unsupported config key for commitMessage.template",
      );
    });
  }, 15_000);

  it.each([
    {
      label: "preventSleep: unrecognized value",
      yaml: "preventSleep: flase\n",
      expected: "Invalid config value for preventSleep",
    },
    {
      label: "agentPathOverride: unknown agent name",
      yaml: "agentPathOverride:\n  unknown: /bin/x\n",
      expected: "Invalid agent name in agentPathOverride",
    },
    {
      label: "agentPathOverride: non-string value",
      yaml: "agentPathOverride:\n  claude: 42\n",
      expected: "Invalid path for agentPathOverride.claude",
    },
    {
      label: "agentPathOverride: blank string",
      yaml: 'agentPathOverride:\n  claude: "   "\n',
      expected: "Invalid path for agentPathOverride.claude",
    },
    {
      label: "agentArgsOverride: unknown agent name",
      yaml: "agentArgsOverride:\n  unknown:\n    - --flag\n",
      expected: "Invalid agent name in agentArgsOverride",
    },
    {
      label: "agentArgsOverride.codex: not an array",
      yaml: 'agentArgsOverride:\n  codex: "--full-auto"\n',
      expected: "Invalid config value for agentArgsOverride.codex",
    },
    {
      label: "agentArgsOverride.codex: blank value",
      yaml: 'agentArgsOverride:\n  codex:\n    - "   "\n',
      expected: "Invalid config value for agentArgsOverride.codex[0]",
    },
    {
      label: "agentArgsOverride.codex: gnhf-managed flag",
      yaml: "agentArgsOverride:\n  codex:\n    - --output-schema=custom.json\n",
      expected: "managed by gnhf",
    },
    {
      label: "agentArgsOverride.rovodev: gnhf-managed flag",
      yaml: "agentArgsOverride:\n  rovodev:\n    - serve\n",
      expected: "managed by gnhf",
    },
    {
      label: "agentArgsOverride.copilot: gnhf-managed flag",
      yaml: "agentArgsOverride:\n  copilot:\n    - --output-format=json\n",
      expected: "managed by gnhf",
    },
    {
      label: "agentArgsOverride.commandcode: gnhf-managed flag",
      yaml: "agentArgsOverride:\n  commandcode:\n    - --print\n",
      expected: "managed by gnhf",
    },
    {
      label: "agentArgsOverride.cursor: gnhf-managed flag",
      yaml: "agentArgsOverride:\n  cursor:\n    - --output-format=stream-json\n",
      expected: "managed by gnhf",
    },
  ])(
    "rejects invalid config: $label",
    async ({ yaml, expected }) => {
      await withTemp(async (temp) => {
        const cwd = createRepo(temp);
        const env = createHomeWithConfig(temp, yaml);

        const result = await runCli(cwd, ["ship it", "--agent", "claude"], env);

        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(expected);
      });
    },
    15_000,
  );
});
