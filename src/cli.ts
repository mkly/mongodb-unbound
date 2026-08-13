#!/usr/bin/env bun

import { runCli } from "./app.ts";
import { crudCommands } from "./crud.ts";
import { inspectCommand, sampleCommand } from "./inspect.ts";

const handlers = [...crudCommands, sampleCommand, inspectCommand];

const exitCode = await runCli(Bun.argv.slice(2), handlers, {
  env: Bun.env,
  stderr: Bun.stderr,
  stdout: Bun.stdout,
});

process.exitCode = exitCode;
