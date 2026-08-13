import { stringifyEjson } from "./ejson.ts";
import type { CliError } from "./errors.ts";

export interface OutputWriter {
  write(value: string): void;
}

export function writeResult(writer: OutputWriter, data: unknown): void {
  writer.write(`${stringifyEjson({ ok: true, data })}\n`);
}

export function writeError(writer: OutputWriter, error: CliError): void {
  writer.write(
    `${stringifyEjson({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    })}\n`,
  );
}
