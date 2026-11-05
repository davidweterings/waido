import type { WideEventData, WideEventRedactor } from "#src/types.js";
import { isPlainObject } from "#src/utils.js";

export interface RedactorOptions {
  /**
   * Dotted paths into `data`. `*` matches one level, including array items:
   * `user.email`, `users.*.email`, `headers.*`.
   */
  paths: string[];
  /** Replacement value. Defaults to `"[REDACTED]"`. */
  censor?: string;
}

function redactPath(container: unknown, segments: string[], censor: string): void {
  if (!isPlainObject(container) && !Array.isArray(container)) {
    return;
  }

  const [segment, ...rest] = segments;
  const record = container as Record<string, unknown>;
  const keys =
    segment === "*" ? Object.keys(record) : Object.hasOwn(record, segment) ? [segment] : [];

  for (const key of keys) {
    if (rest.length === 0) {
      record[key] = censor;
    } else {
      redactPath(record[key], rest, censor);
    }
  }
}

/**
 * Replaces values at known paths in `data`. It does not cover error messages or stacks, so avoid
 * putting secrets in those.
 */
export function createRedactor(options: RedactorOptions): WideEventRedactor {
  const censor = options.censor ?? "[REDACTED]";

  const paths = options.paths.map((path) => {
    const segments = path.split(".");
    if (path.length === 0 || segments.some((segment) => segment.length === 0)) {
      throw new TypeError(`createRedactor received an invalid path: "${path}"`);
    }

    return segments;
  });

  return (data: WideEventData) => {
    for (const segments of paths) {
      redactPath(data, segments, censor);
    }
  };
}
