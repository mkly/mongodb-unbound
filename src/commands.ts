import { collectionCommandHandlers } from "./collection-commands.ts";
import type { CommandHandler } from "./command.ts";
import { crudCommands } from "./crud.ts";
import { inspectCommand, sampleCommand } from "./inspect.ts";

export const commandHandlers: readonly CommandHandler[] = [
  ...crudCommands,
  inspectCommand,
  sampleCommand,
  ...collectionCommandHandlers,
];
