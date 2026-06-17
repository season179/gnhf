#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function appendLog(event, details = {}) {
  const logPath = process.env.GNHF_MOCK_CURSOR_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
    "utf-8",
  );
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readPrompt(args) {
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-p" || arg === "--print") continue;
    if (
      arg === "--stream-partial-output" ||
      arg === "--trust" ||
      arg === "--force"
    ) {
      continue;
    }
    if (
      arg === "--output-format" ||
      arg === "--model" ||
      arg === "--mode" ||
      arg === "--sandbox" ||
      arg === "--header" ||
      arg === "-H" ||
      arg === "--plugin-dir"
    ) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }

  return positional.length === 0 ? undefined : positional.join(" ");
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Cursor 3.7.42

Usage: cursor [options][paths...]

Subcommands
  agent        Start the Cursor agent in your terminal.
`);
  process.exit(0);
}

const agentArgs = args[0] === "agent" ? args.slice(1) : args;
const prompt = readPrompt(agentArgs);

appendLog("invoke", { args, prompt: prompt ?? "" });

if (prompt === undefined) {
  console.error("mock cursor requires -p");
  process.exit(1);
}

if (readOption(agentArgs, "--output-format") !== "stream-json") {
  console.error("mock cursor requires --output-format stream-json");
  process.exit(1);
}

appendFileSync(
  join(process.cwd(), "README.md"),
  `- mock cursor change ${Date.now()}\n`,
  "utf-8",
);

const output = {
  success: true,
  summary: "mock cursor completed",
  key_changes_made: ["README.md was updated by the mock Cursor agent"],
  key_learnings: ["Mock Cursor exercised the headless stream-json adapter"],
};

console.log(
  JSON.stringify({
    type: "assistant",
    timestamp_ms: Date.now(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Mock Cursor is working." }],
    },
  }),
);
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(output),
    usage: {
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    },
  }),
);
