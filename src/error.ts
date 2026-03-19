import type { WideEventError, WideEventErrorDetails } from "#src/types.js";
import { safeStringify } from "#src/utils.js";

interface ErrorWithCode extends Error {
  code?: string | number;
  cause?: unknown;
  why?: string;
  fix?: string;
  link?: string;
}

export interface StructuredErrorInit extends ErrorOptions {
  name?: string;
  message: string;
  code?: string | number;
  why?: string;
  fix?: string;
  link?: string;
}

export class WideEventStructuredError extends Error {
  public readonly code?: string | number;
  public readonly why?: string;
  public readonly fix?: string;
  public readonly link?: string;

  public constructor(init: StructuredErrorInit) {
    super(init.message, {
      cause: init.cause,
    });

    this.name = init.name ?? "WideEventStructuredError";
    this.code = init.code;
    this.why = init.why;
    this.fix = init.fix;
    this.link = init.link;
  }
}

export function createStructuredError(init: StructuredErrorInit): WideEventStructuredError {
  return new WideEventStructuredError(init);
}

export function normalizeError(error: unknown, details?: WideEventErrorDetails): WideEventError {
  if (error instanceof Error) {
    const typedError = error as ErrorWithCode;

    return {
      name: typedError.name,
      message: typedError.message,
      stack: typedError.stack,
      code: details?.code ?? typedError.code,
      cause: typedError.cause ? safeStringify(typedError.cause) : undefined,
      why: details?.why ?? typedError.why,
      fix: details?.fix ?? typedError.fix,
      link: details?.link ?? typedError.link,
    };
  }

  return {
    name: "NonErrorThrown",
    message: safeStringify(error),
    code: details?.code,
    why: details?.why,
    fix: details?.fix,
    link: details?.link,
  };
}
