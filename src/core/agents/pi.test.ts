import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { PiAgent, selectAgentJson } from "./pi.js";
import { buildAgentOutputSchema, validateAgentOutput } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function finalOutput(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    summary: "ok",
    key_changes_made: [],
    key_learnings: [],
    ...extra,
  });
}

describe("PiAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the pi agent name", () => {
    expect(new PiAgent().name).toBe("pi");
  });

  it("spawns pi in JSON mode and writes the augmented prompt to stdin", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ extraArgs: ["--provider", "google"] });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "pi",
      ["--provider", "google", "--mode", "json", "--no-session"],
      {
        cwd: "/work/dir",
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("test prompt"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("gnhf final output contract"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("key_changes_made"),
    );
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("uses a custom binary path", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ bin: "/custom/pi" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/pi",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ bin: "C:\\tools\\pi.cmd", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\pi.cmd",
      expect.any(Array),
      expect.objectContaining({ detached: false, shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue("C:\\tools\\pi.cmd\r\n" as never);
    const agent = new PiAgent({ bin: "pi-switch", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "pi-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new PiAgent({ platform: "win32" });

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

  it("streams text deltas to onMessage", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir", { onMessage });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", responseId: "r1" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", responseId: "r1" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        text: finalOutput(),
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
    expect(onMessage).toHaveBeenCalledWith("hello");
    expect(onMessage).toHaveBeenCalledWith(finalOutput());
  });

  it("does not inflate usage when anonymous message streams multiple message_update events", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", usage: { input: 5, output: 3 } },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hel",
      },
    });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", usage: { input: 5, output: 3 } },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "lo",
      },
    });
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 5, output: 3 },
        content: [{ type: "text", text: finalOutput() }],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ output: { success: true } });
    const lastCall = onUsage.mock.calls[onUsage.mock.calls.length - 1][0];
    expect(lastCall.inputTokens).toBe(5);
    expect(lastCall.outputTokens).toBe(3);
  });

  it("maps usage from assistant messages and defaults missing fields to zero", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "r1",
        usage: { input: 11, output: 7, cacheRead: 3 },
        content: [{ type: "text", text: finalOutput() }],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
      },
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
    });
  });

  it("uses the final assistant message from agent_end as a fallback", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "agent_end",
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: finalOutput() },
      ],
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("requires should_fully_stop when the schema includes it", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", content: finalOutput() },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("resolves when should_fully_stop is present for stop-field schemas", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        content: finalOutput({ should_fully_stop: true }),
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { should_fully_stop: true },
    });
  });

  it("requires commit fields when the schema includes them", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", content: finalOutput() },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        content: finalOutput({ commit_type: "chore" }),
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("rejects empty final text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", content: "   " },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("pi returned no text output");
  });

  it("rejects malformed JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", content: "not json" },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse pi output");
  });

  it("rejects invalid output shape", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        content: JSON.stringify({
          success: "yes",
          summary: "ok",
          key_changes_made: [],
          key_learnings: [],
        }),
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("rejects Pi-reported assistant errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "auth failed",
        content: finalOutput(),
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("pi reported error: auth failed");
  });

  it("rejects spawn errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn pi: ENOENT");
  });

  it("rejects non-zero exits with stderr", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("bad things"));
    proc.emit("close", 2);

    await expect(promise).rejects.toThrow("pi exited with code 2: bad things");
  });

  // The real-world failure mode: pi emits a valid structured object in one turn,
  // then keeps working and ends with a prose summary in later turns.
  it("recovers the structured output emitted before later prose turns", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "r1",
        content: [{ type: "text", text: finalOutput({ summary: "the real answer" }) }],
      },
    });
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "r2",
        content: [
          { type: "text", text: "No background processes running.\n\n## Summary\nDone." },
        ],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "the real answer" },
    });
  });

  it("does not collide when later turns reuse contentIndex 0", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    // Turn 1: structured JSON at contentIndex 0.
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", responseId: "r1" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        text: finalOutput({ summary: "kept" }),
      },
    });
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", responseId: "r1" },
    });
    // Turn 2: prose, also at contentIndex 0 — must not overwrite turn 1.
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant", responseId: "r2" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        text: "all green, nothing else to do",
      },
    });
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", responseId: "r2" },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "kept" },
    });
  });

  it("joins multiple content blocks and extracts JSON embedded with prose", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "r1",
        content: [
          { type: "text", text: finalOutput({ summary: "blocky" }) },
          { type: "text", text: "\n\nThat completes the iteration." },
        ],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "blocky" },
    });
  });

  it("separates anonymous turns at turn_start so index reuse does not clobber", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    // Anonymous messages (no responseId): turn boundaries come from turn_start.
    emitJson(proc, { type: "turn_start", message: { role: "assistant" } });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        text: finalOutput({ summary: "first turn" }),
      },
    });
    emitJson(proc, { type: "turn_start", message: { role: "assistant" } });
    emitJson(proc, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        text: "wrap-up prose, no json",
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "first turn" },
    });
  });
});

describe("selectAgentJson", () => {
  const schema = buildAgentOutputSchema({ includeStopField: false });
  const accepts = (value: unknown): boolean => {
    try {
      validateAgentOutput(value, schema);
      return true;
    } catch {
      return false;
    }
  };
  const good = (summary: string) =>
    JSON.stringify({
      success: true,
      summary,
      key_changes_made: [],
      key_learnings: [],
    });

  it("returns a whole-segment pure-JSON object", () => {
    const result = selectAgentJson([good("a")], accepts) as { summary: string };
    expect(result.summary).toBe("a");
  });

  it("returns JSON from an earlier segment when later segments are prose", () => {
    const result = selectAgentJson(
      [good("a"), "done.\n\n## Summary\nfinished"],
      accepts,
    ) as { summary: string };
    expect(result.summary).toBe("a");
  });

  it("extracts a JSON object embedded in prose", () => {
    const result = selectAgentJson(
      [`Here is the result: ${good("a")} — thanks!`],
      accepts,
    ) as { summary: string };
    expect(result.summary).toBe("a");
  });

  it("prefers a pure-JSON turn over a trailing fenced example", () => {
    const result = selectAgentJson(
      [good("real"), `For reference:\n\`\`\`json\n${good("example")}\n\`\`\``],
      accepts,
    ) as { summary: string };
    expect(result.summary).toBe("real");
  });

  it("returns the most recent valid pure-JSON segment", () => {
    const result = selectAgentJson([good("old"), good("new")], accepts) as {
      summary: string;
    };
    expect(result.summary).toBe("new");
  });

  it("returns null when no segment contains JSON", () => {
    expect(selectAgentJson(["just prose", "more prose"], accepts)).toBeNull();
  });

  it("falls back to a parseable but schema-invalid object for diagnostics", () => {
    const invalid = JSON.stringify({
      success: "yes",
      summary: "x",
      key_changes_made: [],
      key_learnings: [],
    });
    const result = selectAgentJson([invalid], accepts) as { success: unknown };
    expect(result).not.toBeNull();
    expect(result.success).toBe("yes");
  });
});
