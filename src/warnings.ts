import type { WideEventErrorContext, WideEventErrorStage } from "#src/types.js";
import { safeStringify } from "#src/utils.js";

const WARNING_INTERVAL_MS = 60_000;
const MAX_CAUSE_DEPTH = 3;

function describeError(error: unknown): string {
  const parts: string[] = [];
  let current = error;

  while (parts.length <= MAX_CAUSE_DEPTH && current !== undefined && current !== null) {
    parts.push(current instanceof Error ? current.message : safeStringify(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return parts.join(": ");
}

/**
 * The `onError` used when the app doesn't set one: a warning on stderr, so a backend outage can't
 * go unnoticed. It writes at most once per minute for each kind of failure, so an outage can't
 * flood the logs either.
 */
export function createDefaultErrorHandler(): (
  error: unknown,
  context: WideEventErrorContext,
) => void {
  const lastWarnings = new Map<WideEventErrorStage, { at: number; suppressed: number }>();

  return (error, context) => {
    const now = Date.now();
    const last = lastWarnings.get(context.stage);

    if (last !== undefined && now - last.at < WARNING_INTERVAL_MS) {
      last.suppressed += 1;
      return;
    }

    lastWarnings.set(context.stage, { at: now, suppressed: 0 });

    const suppressed =
      last && last.suppressed > 0 ? ` (${last.suppressed} more since last warning)` : "";
    console.error(
      `[waido] ${context.stage}: ${describeError(error)}${suppressed}. Set onError to handle these yourself.`,
    );
  };
}
