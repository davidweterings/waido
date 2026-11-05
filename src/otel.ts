import {
  type Attributes,
  type Context,
  isSpanContextValid,
  logs,
  ROOT_CONTEXT,
  SeverityNumber,
  type Span,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";

import type {
  WideEvent,
  WideEventCandidate,
  WideEventData,
  WideEventIntegration,
} from "#src/types.js";
import { isPlainObject } from "#src/utils.js";

const LOGGER_NAME = "waido";
const LOG_EVENT_NAME = "waido.wide_event";
const DEFAULT_SAMPLE_RATE_ATTRIBUTE = "waido.sample_rate";

export interface OtelOptions {
  /** Emit each kept event as an OpenTelemetry log record. Defaults to true. */
  logs?: boolean;
  /** Copy fields onto the active span while it is recording. Defaults to true. */
  spans?: boolean;
  /** Log attribute holding the 1-in-N sample rate. Defaults to `waido.sample_rate`. */
  sampleRateAttribute?: string;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function toAttributeArray(values: unknown[]): unknown {
  const isHomogeneousPrimitive =
    values.every(isPrimitive) && new Set(values.map((value) => typeof value)).size <= 1;

  return isHomogeneousPrimitive ? values : JSON.stringify(values);
}

/** Flattens nested fields into the dotted keys backends index: `http.route`, `user.id`. */
function flatten(data: WideEventData, prefix: string, output: Attributes): Attributes {
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (isPrimitive(value)) {
      output[name] = value;
    } else if (Array.isArray(value)) {
      output[name] = toAttributeArray(value);
    } else if (isPlainObject(value)) {
      flatten(value, name, output);
    }
  }

  return output;
}

function compact(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Attributes;
}

function toSharedAttributes(event: WideEventCandidate): Attributes {
  return {
    ...flatten(event.data, "", {}),
    ...compact({
      "waido.event.id": event.id,
      "waido.event.name": event.name,
      "waido.event.parent_id": event.parentId,
      "waido.event.kind": event.kind,
      "waido.outcome": event.outcome,
      "waido.duration_ms": event.durationMs,
      "waido.status": event.status,
      "waido.payload.truncated": event.payload.truncated || undefined,
      "waido.error_count":
        event.errors.length > 0 ? event.errors.length + (event.errorsDropped ?? 0) : undefined,
      "error.type": event.errors[0]?.name,
    }),
  };
}

/**
 * Express auto-instrumentation makes a short-lived `middleware` span active while middleware runs,
 * and it has already ended by the time waido's middleware starts. HTTP instrumentation binds the
 * server span's context to the response, so when the span captured at the start is no longer
 * recording, the span active now is the one that should receive the fields.
 */
function resolveTargetSpan(started: Span): Span {
  if (started.isRecording()) {
    return started;
  }

  const active = trace.getActiveSpan();
  const isSameTrace = active?.spanContext().traceId === started.spanContext().traceId;
  return active !== undefined && isSameTrace ? active : started;
}

function mirrorToSpan(span: Span, event: WideEventCandidate): void {
  if (!span.isRecording()) {
    return;
  }

  span.setAttributes(toSharedAttributes(event));

  for (const error of event.errors) {
    span.recordException({
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
    });
  }

  if (event.outcome === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: event.errors[0]?.message });
  }
}

/**
 * The drain runs in the background, so the event's trace is attached explicitly rather than read
 * from the active context.
 */
function toLogContext(event: WideEvent): Context {
  const spanContext = {
    traceId: event.traceId ?? "",
    spanId: event.spanId ?? event.parentSpanId ?? "",
    traceFlags: event.traceSampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  };

  return isSpanContextValid(spanContext)
    ? trace.setSpanContext(ROOT_CONTEXT, spanContext)
    : ROOT_CONTEXT;
}

function emitLogRecord(event: WideEvent, sampleRateAttribute: string): void {
  const isError = event.outcome === "error";
  const firstError = event.errors[0];

  logs.getLogger(LOGGER_NAME).emit({
    eventName: LOG_EVENT_NAME,
    timestamp: new Date(event.endedAt),
    severityNumber: isError ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: isError ? "ERROR" : "INFO",
    body: event.name,
    context: toLogContext(event),
    attributes: {
      ...toSharedAttributes(event),
      ...compact({
        [sampleRateAttribute]: event.sampling.sampleRate,
        "waido.sampling.reason": event.sampling.reason,
        "waido.sampling.rule": event.sampling.rule,
        "exception.type": firstError?.name,
        "exception.message": firstError?.message,
        "exception.stacktrace": firstError?.stack,
      }),
    },
  });
}

/**
 * Connects waido to OpenTelemetry through `@opentelemetry/api`. Your application still sets up the
 * SDK: without a `LoggerProvider`, log records go nowhere.
 *
 * - Takes trace and span IDs from the active span.
 * - Copies an event's fields onto that span before sampling, so a dropped event still enriches a
 *   recording span. If several events share a span, only the first writes to it.
 * - Emits each kept event as a log record, which isn't affected by the span's own sampling.
 */
export function otel(options: OtelOptions = {}): WideEventIntegration {
  const {
    logs: emitLogs = true,
    spans: mirrorSpans = true,
    sampleRateAttribute = DEFAULT_SAMPLE_RATE_ATTRIBUTE,
  } = options;

  const ownedSpans = new WeakSet<Span>();

  return {
    name: "otel",
    begin: () => {
      const span = trace.getActiveSpan();
      const spanContext = span?.spanContext();
      if (span === undefined || spanContext === undefined || !isSpanContextValid(spanContext)) {
        return undefined;
      }

      // Only the first event on a span writes to it. Otherwise a nested scope sharing its parent's
      // span could overwrite the parent's fields, or mark the whole request as failed.
      const ownsSpan = !ownedSpans.has(span);
      ownedSpans.add(span);

      return {
        traceContext: {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          traceSampled: (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
        },
        onFinalize: (event) => {
          const target = resolveTargetSpan(span);
          event.spanId = target.spanContext().spanId;

          if (mirrorSpans && ownsSpan) {
            mirrorToSpan(target, event);
          }
        },
      };
    },
    drain: emitLogs
      ? (event) => {
          emitLogRecord(event, sampleRateAttribute);
        }
      : undefined,
  };
}
