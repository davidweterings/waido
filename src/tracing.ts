import { createRequire } from "node:module";

import type * as OtelApi from "@opentelemetry/api";

import { toEventAttributes } from "#src/attributes.js";
import type { WideEventCandidate, WideEventTraceContext } from "#src/types.js";

type Api = typeof OtelApi;
type Span = OtelApi.Span;

const SAMPLED_FLAG = 1;
const SUPPRESS_TRACING_KEY = "OpenTelemetry SDK Context Key SUPPRESS_TRACING";

/** Connects one event to the span it started on. */
export interface TraceBinding {
  traceContext: WideEventTraceContext;
  /** Runs synchronously for every event, before the sampling decision. */
  onFinalize: (event: WideEventCandidate) => void;
}

let cachedApi: Api | null | undefined;

/**
 * Finds the app's OpenTelemetry API, if it has one. It is loaded synchronously so `initWaido` can
 * stay synchronous. The API keeps its state in a process-wide registry, so this sees the app's
 * tracer however the app imported it.
 */
function getApi(): Api | undefined {
  if (cachedApi === undefined) {
    try {
      const api = createRequire(import.meta.url)("@opentelemetry/api") as Api;
      cachedApi = typeof api.trace?.getActiveSpan === "function" ? api : null;
    } catch {
      cachedApi = null;
    }
  }

  return cachedApi ?? undefined;
}

/** Pass `null` to act as if the app doesn't use OpenTelemetry, or `undefined` to detect again. */
export function __setTracingApiForTests(api: null | undefined): void {
  cachedApi = api;
}

/**
 * Express auto-instrumentation makes a short-lived `middleware` span active while middleware runs,
 * and it has already ended by the time waido's middleware starts. HTTP instrumentation binds the
 * server span's context to the response, so when the span an event started on is no longer
 * recording, the span active now is the one that should receive the fields.
 */
function resolveTargetSpan(api: Api, started: Span): Span {
  if (started.isRecording()) {
    return started;
  }

  const active = api.trace.getActiveSpan();
  const isSameTrace = active?.spanContext().traceId === started.spanContext().traceId;
  return active !== undefined && isSameTrace ? active : started;
}

function enrichSpan(api: Api, span: Span, event: WideEventCandidate): void {
  if (!span.isRecording()) {
    return;
  }

  span.setAttributes(toEventAttributes(event));

  for (const error of event.errors) {
    span.recordException({
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
    });
  }

  if (event.outcome === "error") {
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: event.errors[0]?.message });
  }
}

/**
 * Returns a function connecting new events to the active span. Without an active span, which
 * includes apps that don't use tracing at all, it does nothing.
 */
export function createSpanBinder(options: {
  enrichSpans: boolean;
}): () => TraceBinding | undefined {
  // Only the first event on a span writes to it. Otherwise a nested scope sharing its parent's span
  // could overwrite the parent's fields, or mark the whole request as failed.
  const ownedSpans = new WeakSet<Span>();

  return () => {
    const api = getApi();
    const span = api?.trace.getActiveSpan();
    if (api === undefined || span === undefined) {
      return undefined;
    }

    const spanContext = span.spanContext();
    if (!api.isSpanContextValid(spanContext)) {
      return undefined;
    }

    const ownsSpan = !ownedSpans.has(span);
    ownedSpans.add(span);

    return {
      traceContext: {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceSampled: (spanContext.traceFlags & SAMPLED_FLAG) === SAMPLED_FLAG,
      },
      onFinalize: (event) => {
        const target = resolveTargetSpan(api, span);
        event.spanId = target.spanContext().spanId;

        if (options.enrichSpans && ownsSpan) {
          enrichSpan(api, target, event);
        }
      },
    };
  };
}

/**
 * Runs waido's own network calls outside the app's trace. If the app instruments `fetch`, exporting
 * events would otherwise create spans about exporting events, attached to whichever request
 * happened to trigger the send.
 */
export function runWithoutTracing<T>(work: () => T): T {
  const api = getApi();
  if (api === undefined) {
    return work();
  }

  const suppressed = api.ROOT_CONTEXT.setValue(api.createContextKey(SUPPRESS_TRACING_KEY), true);
  return api.context.with(suppressed, work);
}
