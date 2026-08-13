import type { Db, MongoClient } from "mongodb";

import type { ConnectionConfig } from "./config.ts";
import type { OutputWriter } from "./output.ts";

export interface CommandContext {
  client: MongoClient;
  config: ConnectionConfig;
  db: Db;
  stderr: OutputWriter;
  stdout: OutputWriter;
}

export interface CommandHandler {
  name: string;
  run(context: CommandContext, args: readonly string[]): Promise<unknown>;
  summary: string;
  usage?: string;
}

export function createCommandRegistry(
  handlers: readonly CommandHandler[],
): ReadonlyMap<string, CommandHandler> {
  const registry = new Map<string, CommandHandler>();
  for (const handler of handlers) {
    if (registry.has(handler.name)) {
      throw new Error(`Duplicate command handler: ${handler.name}`);
    }
    registry.set(handler.name, handler);
  }
  return registry;
}
