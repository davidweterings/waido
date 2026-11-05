export type WideEventKind = string;

export type WideEventOutcome = "success" | "error" | "aborted";

/**
 * Free-form event fields. Values are `any` so sampler rules and enrichers can read nested fields
 * (`event.data.user?.tier`) without a cast at every level.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type WideEventData = Record<string, any>;

export interface WideEventTraceContext {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceSampled?: boolean;
}

export interface WideEventError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: string;
  why?: string;
  fix?: string;
  link?: string;
}

export interface WideEventSamplingDecision {
  sampled: boolean;
  reason?: string;
  rule?: string;
  /** This event represents 1 in `sampleRate` events. Defaults to 1. */
  sampleRate?: number;
}

export interface WideEventSampling {
  reason?: string;
  rule?: string;
  sampleRate: number;
}

export interface WideEventPayloadInfo {
  sizeBytes: number;
  truncated: boolean;
  maxBytes: number;
}

export interface WideEvent {
  id: string;
  parentId?: string;
  name: string;
  kind: WideEventKind;
  service?: string;
  environment?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: WideEventOutcome;
  status?: number | string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceSampled?: boolean;
  sampling: WideEventSampling;
  payload: WideEventPayloadInfo;
  data: WideEventData;
  errors: WideEventError[];
  errorsDropped?: number;
}

/** The event as seen by enrichers, before redaction and the size limit. */
export type WideEventDraft = Omit<WideEvent, "sampling" | "payload">;

/** The event as seen by samplers, before the sampling decision. */
export type WideEventCandidate = Omit<WideEvent, "sampling">;

export type WideEventSamplerResult = boolean | WideEventSamplingDecision;

/** Decides whether an event is kept. Must be synchronous. */
export type WideEventSampler = (event: WideEventCandidate) => WideEventSamplerResult;

export type WideEventKeepRule = ((event: WideEventCandidate) => boolean) & { ruleName?: string };

export interface WideEventDrainContext {
  /** Reports a failure that happened outside a call to the drain, such as a background send. */
  report: (error: unknown) => void;
}

/** Receives kept events. Any function works. Batching drains can add `start` and `flush`. */
export interface WideEventDrain {
  (event: WideEvent): void | Promise<void>;
  /** Called once when the runtime starts using this drain. */
  start?: (context: WideEventDrainContext) => void;
  /** Sends anything still held. Called by `flush()`, `destroy()` and when the runtime is replaced. */
  flush?: () => Promise<void>;
}

export interface WideEventEnrichContext {
  event: WideEventDraft;
}

/** Adds fields to an event while it is being finalized. Must be synchronous. */
export type WideEventEnricher = (context: WideEventEnrichContext) => void;

/** Removes sensitive values from `data`. Must be synchronous. */
export type WideEventRedactor = (data: WideEventData) => void;

export interface WideEventPayloadPolicy {
  /** Defaults to 64 KiB. */
  maxBytes?: number;
  truncatePlaceholder?: string;
}

/** Return `false` to skip capturing this unit of work entirely. */
export type WideEventFilter = (input: StartWideEventInput) => boolean;

export type WideEventTraceContextExtractor = (
  input: StartWideEventInput,
) => WideEventTraceContext | undefined;

export type WideEventErrorStage =
  | "filter"
  | "trace_context"
  | "tracing"
  | "enricher"
  | "redact"
  | "sampler"
  | "drain"
  | "drain_timeout"
  | "late_write"
  | "adapter"
  | "internal";

export interface WideEventErrorContext {
  stage: WideEventErrorStage;
  eventId?: string;
  eventName?: string;
  /** Position of the failing enricher or drain in its list. */
  index?: number;
}

export interface WideEventRuntimeConfig {
  service?: string;
  environment?: string;
  filter?: WideEventFilter;
  sampler?: WideEventSampler;
  enrichers?: WideEventEnricher[];
  redact?: WideEventRedactor;
  /**
   * Where kept events go. When omitted, events are written to stdout as JSON. Pass `[]` to send
   * them nowhere.
   */
  drains?: WideEventDrain[];
  /**
   * If the app uses OpenTelemetry tracing, copy event fields onto the active span. Trace IDs are
   * picked up either way. Defaults to true.
   */
  enrichSpans?: boolean;
  payloadPolicy?: WideEventPayloadPolicy;
  traceContextExtractor?: WideEventTraceContextExtractor;
  /** Per-drain time limit. A drain that exceeds it is reported to `onError` and no longer tracked. */
  emitTimeoutMs?: number;
  now?: () => Date;
  idGenerator?: () => string;
  /**
   * Receives telemetry failures, which never reach the code being observed. Replaces the default,
   * which warns on stderr at most once a minute for each kind of failure.
   */
  onError?: (error: unknown, context: WideEventErrorContext) => void;
}

export interface StartWideEventInput {
  name: string;
  kind?: WideEventKind;
  data?: WideEventData;
  status?: number | string;
  traceContext?: WideEventTraceContext;
  samplingDecision?: WideEventSamplingDecision;
}

export interface EmitWideEventInput {
  name?: string;
  /** Sets the outcome explicitly, like `setOutcome()`. */
  outcome?: WideEventOutcome;
  /** Marks the work as abandoned. A recorded error or explicit outcome still takes priority. */
  aborted?: boolean;
  status?: number | string;
  data?: WideEventData;
  samplingDecision?: WideEventSamplingDecision;
}

export interface WideEventErrorDetails {
  why?: string;
  fix?: string;
  link?: string;
  code?: string | number;
}
