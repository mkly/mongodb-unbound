#!/usr/bin/env bun

import { runCli } from "./app.ts";
import { commandHandlers } from "./commands.ts";

const exitCode = await runCli(Bun.argv.slice(2), commandHandlers, {
  env: Bun.env,
  stderr: Bun.stderr,
  stdout: Bun.stdout,
});

process.exitCode = exitCode;
