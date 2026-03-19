import type { WideEventTraceContext } from "#src/types.js";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }

  if (Array.isArray(direct) && direct.length > 0) {
    return direct[0];
  }

  const lowered = headers[name.toLowerCase()];
  if (typeof lowered === "string") {
    return lowered;
  }

  if (Array.isArray(lowered) && lowered.length > 0) {
    return lowered[0];
  }

  return undefined;
}

export function parseTraceparent(traceparent: string): WideEventTraceContext | undefined {
  const trimmed = traceparent.trim();
  const match = TRACEPARENT_REGEX.exec(trimmed);
  if (!match) {
    return undefined;
  }

  return {
    traceId: match[2],
    spanId: match[3],
    traceparent: trimmed,
    source: "traceparent",
  };
}

export function extractTraceContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): WideEventTraceContext | undefined {
  const traceparent = readHeader(headers, "traceparent");
  const tracestate = readHeader(headers, "tracestate");

  if (!traceparent) {
    return undefined;
  }

  const parsed = parseTraceparent(traceparent);
  if (!parsed) {
    return undefined;
  }

  if (tracestate) {
    parsed.tracestate = tracestate;
  }

  return parsed;
}
