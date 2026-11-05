import { compact, toEventAttributes, type AttributeValue } from "#src/attributes.js";
import { runWithoutTracing } from "#src/tracing.js";
import type { WideEvent, WideEventDrain } from "#src/types.js";

const LOGS_PATH = "/v1/logs";
const SCOPE_NAME = "waido";
const EVENT_NAME = "waido.wide_event";
const DEFAULT_SERVICE_NAME = "unknown_service:node";
const DEFAULT_SAMPLE_RATE_ATTRIBUTE = "waido.sample_rate";
const SEVERITY_INFO = 9;
const SEVERITY_ERROR = 17;
const SAMPLED_FLAG = 1;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 30_000;
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;

export interface OtlpDrainOptions {
  /**
   * Base URL of an OTLP/HTTP receiver, such as `https://collector.example.com:4318`. Defaults to
   * `OTEL_EXPORTER_OTLP_ENDPOINT`. `/v1/logs` is added unless the URL already ends with it.
   */
  endpoint?: string;
  /** Sent with every request, on top of any in `OTEL_EXPORTER_OTLP_HEADERS`. */
  headers?: Record<string, string>;
  /** Attribute holding the 1-in-N sample rate. Defaults to `waido.sample_rate`. */
  sampleRateAttribute?: string;
  /** Sends as soon as this many events are waiting. Defaults to 512. */
  maxBatchSize?: number;
  /** Sends waiting events after this long at most. Defaults to 5000. */
  flushIntervalMs?: number;
  /** Events beyond this many waiting are dropped and reported. Defaults to 2048. */
  maxQueueSize?: number;
  /** Time limit for each request. Defaults to 10000. */
  requestTimeoutMs?: number;
  /** Retries for each batch after the first attempt. Defaults to 5. */
  maxRetries?: number;
  /** Delay before the first retry, doubling each time. Defaults to 1000. */
  initialRetryDelayMs?: number;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`createOtlpDrain ${name} must be a positive number. Received: ${value}`);
  }
}

function resolveUrl(endpoint: string | undefined): string {
  if (!endpoint) {
    throw new TypeError(
      "createOtlpDrain needs an endpoint. Pass one, or set OTEL_EXPORTER_OTLP_ENDPOINT.",
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("createOtlpDrain received an endpoint that isn't a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("createOtlpDrain needs an http or https endpoint");
  }

  // `fetch` refuses these URLs, and its error repeats the password.
  if (url.username || url.password) {
    throw new TypeError(
      "createOtlpDrain can't use credentials in the endpoint. Use headers instead.",
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(LOGS_PATH) ? path : `${path}${LOGS_PATH}`;
  return url.toString();
}

/** Checks headers up front, because `fetch` repeats an invalid value, likely a token, in its error. */
function assertValidHeaders(headers: Record<string, string>): void {
  try {
    new Headers(headers);
  } catch {
    throw new TypeError("createOtlpDrain received a header with an invalid name or value");
  }
}

/** Parses `key=value,key2=value2`, the format of `OTEL_EXPORTER_OTLP_HEADERS`. */
function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const pair of (value ?? "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();
    try {
      headers[key] = decodeURIComponent(raw);
    } catch {
      headers[key] = raw;
    }
  }

  return headers;
}

function toAnyValue(value: AttributeValue): unknown {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toAnyValue) } };
  }

  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function toKeyValues(attributes: Record<string, AttributeValue>): unknown[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function toLogRecord(event: WideEvent, sampleRateAttribute: string): unknown {
  const isError = event.outcome === "error";
  const firstError = event.errors[0];
  const spanId = event.spanId ?? event.parentSpanId;
  const timeUnixNano = String(BigInt(Date.parse(event.endedAt)) * 1_000_000n);
  const hasTrace =
    event.traceId !== undefined &&
    TRACE_ID_REGEX.test(event.traceId) &&
    spanId !== undefined &&
    SPAN_ID_REGEX.test(spanId);

  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: isError ? SEVERITY_ERROR : SEVERITY_INFO,
    severityText: isError ? "ERROR" : "INFO",
    eventName: EVENT_NAME,
    body: { stringValue: event.name },
    attributes: toKeyValues({
      ...toEventAttributes(event),
      ...compact({
        [sampleRateAttribute]: event.sampling.sampleRate,
        "waido.sampling.reason": event.sampling.reason,
        "waido.sampling.rule": event.sampling.rule,
        "exception.type": firstError?.name,
        "exception.message": firstError?.message,
        "exception.stacktrace": firstError?.stack,
      }),
    }),
    ...(hasTrace
      ? { traceId: event.traceId, spanId, flags: event.traceSampled ? SAMPLED_FLAG : 0 }
      : {}),
  };
}

function toRequestBody(
  events: WideEvent[],
  sampleRateAttribute: string,
  fallbackService: string,
): string {
  const groups = new Map<string, WideEvent[]>();

  for (const event of events) {
    const key = JSON.stringify([event.service, event.environment]);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return JSON.stringify({
    resourceLogs: [...groups.values()].map((group) => ({
      resource: {
        attributes: toKeyValues(
          compact({
            "service.name": group[0].service ?? fallbackService,
            "deployment.environment.name": group[0].environment,
          }),
        ),
      },
      scopeLogs: [
        {
          scope: { name: SCOPE_NAME },
          logRecords: group.map((event) => toLogRecord(event, sampleRateAttribute)),
        },
      ],
    })),
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function readRejectedCount(responseBody: string): number {
  try {
    const parsed = JSON.parse(responseBody) as {
      partialSuccess?: { rejectedLogRecords?: string | number };
    };
    return Number(parsed.partialSuccess?.rejectedLogRecords ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Doesn't keep the process alive by itself. A running `flush()` does that until its timeout, so a
 * failing backend can't hold up shutdown for longer than the caller asked for.
 */
function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs).unref();
  });
}

/**
 * Sends kept events to any OTLP/HTTP receiver as JSON-encoded log records, in batches. It needs no
 * other packages. Receivers that only accept binary protobuf won't work directly, but the
 * OpenTelemetry Collector accepts JSON and can forward to them.
 *
 * Call `flush()` or `destroy()` on the runtime before the process exits, or waiting events are lost.
 */
export function createOtlpDrain(options: OtlpDrainOptions = {}): WideEventDrain {
  const {
    sampleRateAttribute = DEFAULT_SAMPLE_RATE_ATTRIBUTE,
    maxBatchSize = 512,
    flushIntervalMs = 5_000,
    maxQueueSize = 2_048,
    requestTimeoutMs = 10_000,
    maxRetries = 5,
    initialRetryDelayMs = 1_000,
  } = options;

  assertPositive("maxBatchSize", maxBatchSize);
  assertPositive("flushIntervalMs", flushIntervalMs);
  assertPositive("maxQueueSize", maxQueueSize);
  assertPositive("requestTimeoutMs", requestTimeoutMs);
  assertPositive("initialRetryDelayMs", initialRetryDelayMs);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(`createOtlpDrain maxRetries must be 0 or more. Received: ${maxRetries}`);
  }

  const url = resolveUrl(options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const headers = {
    ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    ...options.headers,
    "content-type": "application/json",
  };
  assertValidHeaders(headers);
  const fallbackService = process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;

  const queue: WideEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  let report: (error: unknown) => void = () => undefined;

  async function exportBatch(batch: WideEvent[]): Promise<void> {
    const body = toRequestBody(batch, sampleRateAttribute, fallbackService);
    const dropped = `${batch.length} event(s) dropped`;

    for (let attempt = 0; ; attempt += 1) {
      let retryAfterMs: number | undefined;
      let failure: Error;

      try {
        const response = await runWithoutTracing(() =>
          fetch(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(requestTimeoutMs),
          }),
        );
        const responseBody = await response.text();

        if (response.ok) {
          const rejected = readRejectedCount(responseBody);
          if (rejected > 0) {
            report(new Error(`OTLP receiver rejected ${rejected} of ${batch.length} event(s)`));
          }
          return;
        }

        failure = new Error(`OTLP export failed with status ${response.status}: ${dropped}`);
        if (!RETRYABLE_STATUSES.has(response.status)) {
          report(failure);
          return;
        }

        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      } catch (error) {
        failure = new Error(`OTLP export failed: ${dropped}`, { cause: error });
      }

      if (attempt >= maxRetries) {
        report(failure);
        return;
      }

      const backoffMs = initialRetryDelayMs * 2 ** attempt * (0.5 + Math.random() / 2);
      await wait(Math.min(retryAfterMs ?? backoffMs, MAX_RETRY_DELAY_MS));
    }
  }

  async function sendAll(): Promise<void> {
    while (queue.length > 0) {
      await exportBatch(queue.splice(0, maxBatchSize));
    }
  }

  function startSending(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    sending ??= sendAll()
      .catch((error: unknown) => {
        report(error);
      })
      .finally(() => {
        sending = undefined;
      });
    return sending;
  }

  const drain = (event: WideEvent): void => {
    if (queue.length >= maxQueueSize) {
      throw new Error(`OTLP queue is full at ${maxQueueSize} events: event dropped`);
    }

    queue.push(event);

    if (queue.length >= maxBatchSize) {
      void startSending();
    } else if (timer === undefined && sending === undefined) {
      timer = setTimeout(() => void startSending(), flushIntervalMs);
      timer.unref();
    }
  };

  return Object.assign(drain, {
    start: (context: { report: (error: unknown) => void }) => {
      report = context.report;
    },
    flush: () => startSending(),
  });
}
