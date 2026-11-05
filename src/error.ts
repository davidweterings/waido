import type { WideEventError, WideEventErrorDetails } from "#src/types.js";
import { safeStringify } from "#src/utils.js";

const MAX_TEXT_LENGTH = 4096;
const TRUNCATED_SUFFIX = "…[truncated]";

interface ErrorWithCode extends Error {
  code?: unknown;
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

function capText(value: string): string {
  return value.length <= MAX_TEXT_LENGTH
    ? value
    : value.slice(0, MAX_TEXT_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

function normalizeCode(code: unknown): string | number | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }

  return typeof code === "string" || typeof code === "number" ? code : safeStringify(code);
}

export function normalizeError(error: unknown, details?: WideEventErrorDetails): WideEventError {
  if (error instanceof Error) {
    const typedError = error as ErrorWithCode;

    return {
      name: typedError.name,
      message: capText(typedError.message),
      stack: typedError.stack === undefined ? undefined : capText(typedError.stack),
      code: details?.code ?? normalizeCode(typedError.code),
      cause: typedError.cause ? capText(safeStringify(typedError.cause)) : undefined,
      why: details?.why ?? typedError.why,
      fix: details?.fix ?? typedError.fix,
      link: details?.link ?? typedError.link,
    };
  }

  return {
    name: "NonErrorThrown",
    message: capText(safeStringify(error)),
    code: details?.code,
    why: details?.why,
    fix: details?.fix,
    link: details?.link,
  };
}
