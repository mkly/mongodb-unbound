import { describe, expect, test } from "bun:test";

import { runCli } from "./app.ts";
import { commandHandlers } from "./commands.ts";

function memoryWriter() {
  let output = "";
  return {
    read: () => output,
    write: (value: string) => {
      output += value;
    },
  };
}

describe("standalone command registry", () => {
  test("exposes the complete public command set exactly once", () => {
    expect(commandHandlers.map(({ name }) => name)).toEqual([
      "insert",
      "find",
      "get",
      "update",
      "delete",
      "inspect",
      "sample",
      "collections",
      "create-collection",
      "indexes",
      "create-index",
      "serve",
    ]);
    expect(new Set(commandHandlers.map(({ name }) => name)).size).toBe(
      commandHandlers.length,
    );
  });

  test("renders every command in help without requiring configuration", async () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();

    expect(
      await runCli(["--help"], commandHandlers, {
        env: {},
        stderr,
        stdout,
      }),
    ).toBe(0);
    expect(stderr.read()).toBe("");
    for (const { name, summary } of commandHandlers) {
      expect(stdout.read()).toContain(name);
      expect(stdout.read()).toContain(summary);
    }
  });
});
