import type { WideEventTraceContext } from "#src/types.js";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/i;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);
const SAMPLED_FLAG = 0x01;

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parses a W3C `traceparent` value. The span ID in the header belongs to the caller, so it is
 * returned as `parentSpanId`: waido does not create spans of its own.
 */
export function parseTraceparent(traceparent: string): WideEventTraceContext | undefined {
  const match = TRACEPARENT_REGEX.exec(traceparent.trim());
  if (!match) {
    return undefined;
  }

  const [, version, traceId, parentSpanId, flags] = match;
  if (
    version.toLowerCase() === "ff" ||
    traceId === INVALID_TRACE_ID ||
    parentSpanId === INVALID_SPAN_ID
  ) {
    return undefined;
  }

  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceSampled: (Number.parseInt(flags, 16) & SAMPLED_FLAG) === SAMPLED_FLAG,
  };
}

export function extractTraceContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): WideEventTraceContext | undefined {
  const traceparent = readHeader(headers, "traceparent");
  return traceparent ? parseTraceparent(traceparent) : undefined;
}
