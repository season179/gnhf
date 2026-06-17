import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import {
  CommandCodeAgent,
  buildCommandCodeArgs,
  isReservedCommandCodeArg,
} from "./commandcode.js";
import { buildAgentOutputSchema, PermanentAgentError } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

describe("buildCommandCodeArgs", () => {
  const schema = buildAgentOutputSchema({ includeStopField: false });

  it("adds print mode defaults for automated runs", () => {
    const args = buildCommandCodeArgs("test prompt", schema);
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toContain("test prompt");
    expect(args.at(-1)).toContain("gnhf final output contract");
    expect(args).toEqual(
      expect.arrayContaining([
        "--trust",
        "--skip-onboarding",
        "--yolo",
        "--max-turns",
        "30",
      ]),
    );
  });

  it("places automation flags before -p and the prompt", () => {
    const args = buildCommandCodeArgs("test prompt", schema);
    const printIndex = args.indexOf("-p");
    expect(printIndex).toBeGreaterThan(-1);
    expect(args.slice(0, printIndex)).toEqual(
      expect.arrayContaining([
        "--trust",
        "--skip-onboarding",
        "--yolo",
        "--max-turns",
        "30",
      ]),
    );
    expect(args[printIndex + 1]).toContain("test prompt");
  });

  it("suppresses the default max-turns cap when user args specify one", () => {
    const args = buildCommandCodeArgs("test prompt", schema, [
      "--max-turns",
      "50",
    ]);
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "50"]));
    expect(args.filter((arg) => arg === "--max-turns")).toHaveLength(1);
  });

  it("suppresses the default max-turns cap for --max-turns=N format", () => {
    const args = buildCommandCodeArgs("test prompt", schema, [
      "--max-turns=50",
    ]);
    expect(args).toEqual(expect.arrayContaining(["--max-turns=50"]));
    expect(args.filter((arg) => arg.startsWith("--max-turns"))).toHaveLength(1);
    expect(args).not.toContain("30");
  });

  it("passes user args through and suppresses managed defaults", () => {
    const args = buildCommandCodeArgs("test prompt", schema, [
      "--model",
      "claude-sonnet-4-6",
      "--trust",
      "--skip-onboarding",
      "--permission-mode",
      "auto-accept",
    ]);
    expect(args.slice(0, 5)).toEqual([
      "--model",
      "claude-sonnet-4-6",
      "--trust",
      "--skip-onboarding",
      "--permission-mode",
    ]);
    expect(args).not.toContain("--yolo");
    expect(args.filter((arg) => arg === "--trust")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--skip-onboarding")).toHaveLength(1);
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toContain("test prompt");
  });
});

describe("isReservedCommandCodeArg", () => {
  it("blocks print and automation flags managed by gnhf", () => {
    expect(isReservedCommandCodeArg("-p")).toBe(true);
    expect(isReservedCommandCodeArg("--trust")).toBe(true);
    expect(isReservedCommandCodeArg("--skip-onboarding")).toBe(true);
    expect(isReservedCommandCodeArg("--yolo")).toBe(true);
    expect(isReservedCommandCodeArg("login")).toBe(true);
  });

  it("allows model and turn-limit overrides", () => {
    expect(isReservedCommandCodeArg("--model")).toBe(false);
    expect(isReservedCommandCodeArg("-m")).toBe(false);
    expect(isReservedCommandCodeArg("--max-turns")).toBe(false);
  });

  it("blocks interactive setup flags that break print-mode automation", () => {
    expect(isReservedCommandCodeArg("--list-models")).toBe(true);
    expect(isReservedCommandCodeArg("--list-models=true")).toBe(true);
    expect(isReservedCommandCodeArg("--ide-setup")).toBe(true);
    expect(isReservedCommandCodeArg("--ide-setup=true")).toBe(true);
  });
});

describe("CommandCodeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.at(-1)).toContain("should_fully_stop");
  });

  it("spawns command-code in print mode with automation defaults", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent({ platform: "darwin" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith("command-code", args, {
      cwd: "/work/dir",
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toContain("test prompt");
    expect(args).toEqual(
      expect.arrayContaining([
        "--trust",
        "--skip-onboarding",
        "--yolo",
        "--max-turns",
        "30",
      ]),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent({
      bin: "C:\\tools\\command-code.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\command-code.cmd",
      expect.any(Array),
      expect.objectContaining({ detached: false, shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\command-code.cmd\r\n" as never,
    );
    const agent = new CommandCodeAgent({
      bin: "command-code",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "command-code",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("parses the final stdout JSON payload", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const agent = new CommandCodeAgent();
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });

    const promise = agent.run("test prompt", "/work/dir", { onMessage });
    proc.stdout.emit("data", Buffer.from(content));
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith(content);
  });

  it("recovers JSON when commandcode prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit(
      "data",
      Buffer.from(
        'Running checks...\n\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}',
      ),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit(
      "data",
      Buffer.from(
        '```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      ),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("treats missing command-code spawn errors as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent();

    const promise = agent.run("test prompt", "/work/dir");
    const error = Object.assign(new Error("spawn command-code ENOENT"), {
      code: "ENOENT",
    });
    proc.emit("error", error);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow(
      "command-code executable was not found",
    );
  });

  it("raises PermanentAgentError when authentication fails", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from("not logged in. Run `cmd login` to authenticate"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow("commandcode authentication failed");
  });

  it("rejects max-turn exits with a clear error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CommandCodeAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("max turns reached"));
    proc.emit("close", 8);

    await expect(promise).rejects.toThrow(
      "commandcode hit --max-turns before completion",
    );
  });

  it("kills the process group on Unix when aborted", async () => {
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const controller = new AbortController();
      const agent = new CommandCodeAgent({ platform: "darwin" });

      const promise = agent.run("test prompt", "/work/dir", {
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toThrow("Agent was aborted");
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CommandCodeAgent({ platform: "win32" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
