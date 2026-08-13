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
  mode?: "one-shot";
  name: string;
  run(context: CommandContext, args: readonly string[]): Promise<unknown>;
  summary: string;
  usage?: string;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface LongRunningCommandHandler {
  mode: "long-running";
  name: string;
  run(
    context: CommandContext,
    args: readonly string[],
    waitForShutdown: () => Promise<ShutdownSignal>,
  ): Promise<void>;
  summary: string;
  usage?: string;
}

export type RegisteredCommandHandler =
  | CommandHandler
  | LongRunningCommandHandler;

export function createCommandRegistry(
  handlers: readonly RegisteredCommandHandler[],
): ReadonlyMap<string, RegisteredCommandHandler> {
  const registry = new Map<string, RegisteredCommandHandler>();
  for (const handler of handlers) {
    if (registry.has(handler.name)) {
      throw new Error(`Duplicate command handler: ${handler.name}`);
    }
    registry.set(handler.name, handler);
  }
  return registry;
}
