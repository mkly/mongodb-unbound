#!/usr/bin/env bun

import { runCli } from "./app.ts";

const exitCode = await runCli(Bun.argv.slice(2), [], {
  env: Bun.env,
  stderr: Bun.stderr,
  stdout: Bun.stdout,
});

process.exitCode = exitCode;
