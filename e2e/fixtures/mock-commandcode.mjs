#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function appendLog(event, details = {}) {
  const logPath = process.env.GNHF_MOCK_COMMANDCODE_LOG_PATH;
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-p" || arg === "--print") {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return next;
      }
      return "";
    }
    if (arg.startsWith("--print=")) {
      return arg.slice("--print=".length);
    }
  }
  return undefined;
}

const args = process.argv.slice(2);
const prompt = readPrompt(args);

appendLog("invoke", { args, prompt: prompt ?? "" });

if (prompt === undefined) {
  console.error("mock command-code requires -p");
  process.exit(1);
}

if (!args.includes("--trust") && !args.includes("-t")) {
  console.error("mock command-code requires --trust");
  process.exit(1);
}

if (!args.includes("--skip-onboarding")) {
  console.error("mock command-code requires --skip-onboarding");
  process.exit(1);
}

if (
  !args.includes("--yolo") &&
  !args.includes("--dangerously-skip-permissions")
) {
  console.error("mock command-code requires --yolo");
  process.exit(1);
}

appendFileSync(
  join(process.cwd(), "README.md"),
  `- mock commandcode change ${Date.now()}\n`,
  "utf-8",
);

const output = {
  success: true,
  summary: "mock commandcode completed",
  key_changes_made: ["README.md was updated by the mock Command Code agent"],
  key_learnings: ["Mock Command Code exercised the print-mode adapter"],
};

const model = readOption(args, "--model") ?? readOption(args, "-m");
if (model) {
  output.key_learnings.push(`model override: ${model}`);
}

console.log(JSON.stringify(output));
