export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { code?: string; exitCode?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = options.code ?? "CLI_ERROR";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error) {
    return new CliError(error.message, {
      code: "UNEXPECTED_ERROR",
      details: { name: error.name },
    });
  }

  return new CliError("An unexpected error occurred", {
    code: "UNEXPECTED_ERROR",
  });
}
