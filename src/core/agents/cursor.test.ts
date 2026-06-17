import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CursorAgent } from "./cursor.js";
import { PermanentAgentError, buildAgentOutputSchema } from "./types.js";

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

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

const VALID_OUTPUT = {
  success: true,
  summary: "ok",
  key_changes_made: [],
  key_learnings: [],
};

function resultEvent(result: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    usage: {
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
    },
    ...overrides,
  };
}

describe("CursorAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("spawns cursor agent in non-interactive stream-json mode with trust + force defaults", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({ bin: "cursor", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith("cursor", args, {
      cwd: "/work/dir",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    expect(args[0]).toBe("agent");
    expect(args).toContain("-p");
    expect(args.at(-1)).toContain("test prompt");
    expect(args.at(-1)).toContain("gnhf final output contract");
    const promptIndex = args.findIndex((arg) => arg.includes("test prompt"));
    expect(promptIndex).toBe(args.length - 1);
    const printIndex = args.indexOf("-p");
    expect(printIndex).toBeGreaterThan(0);
    expect(promptIndex).toBeGreaterThan(printIndex);
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
        "--force",
      ]),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      bin: "C:\\tools\\cursor.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\cursor.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\cursor-launcher.cmd\r\n" as never,
    );
    const agent = new CursorAgent({
      bin: "cursor-launcher",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-launcher",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it.each(["agent", "cursor-agent", "C:\\tools\\cursor-agent.cmd"])(
    "does not add a nested agent subcommand for standalone Cursor Agent binary %s",
    (bin) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent({ bin });

      agent.run("test prompt", "/work/dir");

      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args[0]).toBe("-p");
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--trust",
          "--force",
        ]),
      );
    },
  );

  it("does not add a nested agent subcommand for renamed standalone Cursor Agent wrappers", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "/tools/cursor-agent-wrapper" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: agent [options] [command] [prompt...]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent({
      bin: "/tools/cursor-agent-wrapper",
      platform: "linux",
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe("-p");
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
        "--force",
      ]),
    );
  });

  it("uses a bounded help probe when classifying Cursor wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "/tools/cursor-agent-wrapper" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: agent [options] [command] [prompt...]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent({
      bin: "/tools/cursor-agent-wrapper",
      platform: "linux",
    });

    agent.run("test prompt", "/work/dir");

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "/tools/cursor-agent-wrapper",
      ["--help"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("does not add a nested agent subcommand for wrappers that expose cursor agent help", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "/tools/cursor-agent-wrapper" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: cursor agent [options] [command] [prompt...]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent({
      bin: "/tools/cursor-agent-wrapper",
      platform: "linux",
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe("-p");
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
        "--force",
      ]),
    );
  });

  it("keeps the agent subcommand for Cursor editor launcher wrappers", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "/tools/cursor-wrapper" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Cursor 3.7.42\n\nUsage: cursor [options][paths...]\n\nSubcommands\n  agent        Start the Cursor agent in your terminal.\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent({
      bin: "/tools/cursor-wrapper",
      platform: "linux",
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe("agent");
  });

  it("uses cursor-agent by default when the cursor editor launcher is absent", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "which" && Array.isArray(args) && args[0] === "cursor") {
        throw new Error("not found");
      }
      if (
        command === "which" &&
        Array.isArray(args) &&
        args[0] === "cursor-agent"
      ) {
        return "/usr/local/bin/cursor-agent\n" as never;
      }
      if (
        command === "cursor-agent" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: agent [options]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-agent",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("-p");
  });

  it("uses cursor by default when the editor launcher exposes the agent subcommand", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "which" && Array.isArray(args) && args[0] === "cursor") {
        return "/usr/local/bin/cursor\n" as never;
      }
      if (command === "cursor" && Array.isArray(args) && args[0] === "--help") {
        return "Cursor 3.7.42\n\nUsage: cursor [options][paths...]\n\nSubcommands\n  agent        Start the Cursor agent in your terminal.\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("agent");
  });

  it("falls back to cursor-agent when the cursor binary lacks the agent subcommand", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "which" && Array.isArray(args) && args[0] === "cursor") {
        return "/usr/local/bin/cursor\n" as never;
      }
      if (command === "cursor" && Array.isArray(args) && args[0] === "--help") {
        return "Cursor 2.0.0\n\nUsage: cursor [options][paths...]\n" as never;
      }
      if (
        command === "which" &&
        Array.isArray(args) &&
        args[0] === "cursor-agent"
      ) {
        return "/usr/local/bin/cursor-agent\n" as never;
      }
      if (
        command === "cursor-agent" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: agent [options]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-agent",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("-p");
  });

  it("skips a default cursor-agent binary that does not identify as Cursor Agent", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "which" && Array.isArray(args) && args[0] === "cursor") {
        throw new Error("not found");
      }
      if (
        command === "which" &&
        Array.isArray(args) &&
        args[0] === "cursor-agent"
      ) {
        return "/usr/local/bin/cursor-agent\n" as never;
      }
      if (
        command === "cursor-agent" &&
        Array.isArray(args) &&
        args[0] === "--help"
      ) {
        return "Usage: cursor-agent [options]\n\nDo unrelated work\n" as never;
      }
      if (command === "which" && Array.isArray(args) && args[0] === "agent") {
        return "/usr/local/bin/agent\n" as never;
      }
      if (command === "agent" && Array.isArray(args) && args[0] === "--help") {
        return "Usage: agent [options]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "agent",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("-p");
  });

  it("uses the standalone agent binary only when it identifies as Cursor Agent", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "which" &&
        Array.isArray(args) &&
        (args[0] === "cursor" || args[0] === "cursor-agent")
      ) {
        throw new Error("not found");
      }
      if (command === "which" && Array.isArray(args) && args[0] === "agent") {
        return "/usr/local/bin/agent\n" as never;
      }
      if (command === "agent" && Array.isArray(args) && args[0] === "--help") {
        return "Usage: agent [options]\n\nStart the Cursor Agent\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "agent",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("-p");
  });

  it("keeps the cursor launcher default when a generic agent binary is not Cursor", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (
        command === "which" &&
        Array.isArray(args) &&
        (args[0] === "cursor" || args[0] === "cursor-agent")
      ) {
        throw new Error("not found");
      }
      if (command === "which" && Array.isArray(args) && args[0] === "agent") {
        return "/usr/local/bin/agent\n" as never;
      }
      if (command === "agent" && Array.isArray(args) && args[0] === "--help") {
        return "Usage: agent [options]\n\nDo unrelated work\n" as never;
      }
      throw new Error("unexpected command");
    });
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor",
      expect.any(Array),
      expect.any(Object),
    );
    expect(args[0]).toBe("agent");
  });

  it("passes configured extra args through and suppresses the default --force", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      bin: "cursor",
      extraArgs: ["--model", "gpt-5", "--yolo"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(1, 4)).toEqual(["--model", "gpt-5", "--yolo"]);
    expect(args).not.toContain("--force");
    // --trust is always added; only --force is user-managed.
    expect(args).toContain("--trust");
  });

  it("keeps the default --force when only MCP approval is configured", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--approve-mcps"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--approve-mcps");
    expect(args).toContain("--force");
    expect(args).toContain("--trust");
  });

  it("keeps the default --force when endpoint or TLS overrides are configured", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const extraArgs = [
      "--endpoint",
      "https://api.cursor.test",
      "--insecure",
      "-k",
    ];
    const agent = new CursorAgent({ extraArgs });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(extraArgs));
    expect(args).toContain("--force");
    expect(args).toContain("--trust");
  });

  it.each([["--sandbox", "enabled"], ["--sandbox=disabled"]])(
    "keeps the default --force when sandboxing is configured with %s",
    (...extraArgs) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent({
        extraArgs,
      });

      agent.run("test prompt", "/work/dir");

      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toEqual(expect.arrayContaining(extraArgs));
      expect(args).toContain("--force");
      expect(args).toContain("--trust");
    },
  );

  it("suppresses the default --force when a read-only Cursor mode is configured", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--mode=plan"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--mode=plan");
    expect(args).not.toContain("--force");
    expect(args).toContain("--trust");
  });

  it.each(["--force", "-f", "--yolo", "--plan"])(
    "treats bare execution flag %s as user-managed",
    (flag) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent({
        extraArgs: [flag],
      });

      agent.run("test prompt", "/work/dir");

      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain(flag);
      expect(args.filter((arg) => arg === "--force")).toHaveLength(
        flag === "--force" ? 1 : 0,
      );
      expect(args).toContain("--trust");
    },
  );

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CursorAgent({ platform: "win32" });

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

  it("parses the result event text and reports usage", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 123,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Creating foo.txt.\n" }],
      },
    });
    emitJson(proc, resultEvent(JSON.stringify(VALID_OUTPUT)));
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: VALID_OUTPUT,
      usage: {
        inputTokens: 100,
        outputTokens: 12,
        cacheReadTokens: 50,
        cacheCreationTokens: 5,
      },
    });
    expect(onMessage).toHaveBeenCalledWith("Creating foo.txt.");
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 50,
      cacheCreationTokens: 5,
    });
  });

  it("parses a final result event without a trailing newline", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit(
      "data",
      Buffer.from(JSON.stringify(resultEvent(JSON.stringify(VALID_OUTPUT)))),
    );
    proc.stdout.emit("end");
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true },
    });
  });

  it("streams partial assistant deltas cumulatively and skips duplicate flushes", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", { onMessage });
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 123,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Creating" }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 124,
      message: {
        role: "assistant",
        content: [{ type: "text", text: " foo.txt" }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 125,
      model_call_id: "call_123",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Creating foo.txt" }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Creating foo.txt" }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 126,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    });
    emitJson(proc, resultEvent(JSON.stringify(VALID_OUTPUT)));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true },
    });
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage).toHaveBeenNthCalledWith(1, "Creating");
    expect(onMessage).toHaveBeenNthCalledWith(2, "Creating foo.txt");
    expect(onMessage).toHaveBeenNthCalledWith(3, "Done");
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      resultEvent(
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

  it("recovers JSON when cursor prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      resultEvent(
        'All tests pass.\n\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}',
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

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const promptArg = args.at(-1);
    expect(promptArg).toContain("should_fully_stop");
  });

  it("rejects when cursor returns no result event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor returned no result event");
  });

  it("treats invalid Cursor API key exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from(
        "\x1b[33mWarning: The provided API key is invalid.\x1b[0m\nThe API key was loaded from the CURSOR_API_KEY environment variable.\n",
      ),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow(
      "cursor failed before headless run could start",
    );
  });

  it("treats Cursor unknown-option exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from("error: unknown option '--unsupported'\n"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
  });

  it("treats Cursor authentication-required exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from(
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
      ),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
  });

  it("treats missing Cursor CLI spawn errors as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    const error = Object.assign(new Error("spawn cursor ENOENT"), {
      code: "ENOENT",
    });
    proc.emit("error", error);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow("cursor executable was not found");
  });

  it.each(["EACCES", "EPERM", "ENOEXEC"])(
    "treats non-runnable Cursor CLI spawn error %s as permanent",
    async (code) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent();

      const promise = agent.run("test prompt", "/work/dir");
      const error = Object.assign(new Error(`spawn cursor ${code}`), {
        code,
      });
      proc.emit("error", error);

      await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
      await expect(promise).rejects.toThrow(
        "cursor executable is not runnable",
      );
    },
  );

  it("treats other Cursor non-zero exits as retryable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("temporary network failure\n"));
    proc.emit("close", 1);

    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentAgentError);
  });

  it("rejects when the result event reports an error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      resultEvent("boom", { subtype: "error_max_turns", is_error: true }),
    );
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor reported error");
  });

  it("rejects when the final result text is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, resultEvent("not json"));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects when the final result text misses required fields", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, resultEvent('{"success":true,"summary":"ok"}'));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      resultEvent(JSON.stringify({ ...VALID_OUTPUT, commit_type: "chore" })),
    );
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("falls back to streamed assistant text when the result text is empty", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant",
      timestamp_ms: 123,
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(VALID_OUTPUT) }],
      },
    });
    emitJson(proc, resultEvent("   "));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true },
    });
  });
});
