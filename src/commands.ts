import type { RegisteredCommandHandler } from "./command.ts";
import { crudCommands } from "./crud.ts";
import { inspectCommand, sampleCommand } from "./inspect.ts";
import { serveCommand } from "./serve.ts";

export const commandHandlers: readonly RegisteredCommandHandler[] = [
  ...crudCommands,
  inspectCommand,
  sampleCommand,
  serveCommand,
];
