export type MaybePromise<T> = T | Promise<T>;

export type WideEventKind = string;

export type WideEventOutcome = "success" | "error" | "aborted";

export type WideEventData = Record<string, unknown>;

export interface WideEventTraceContext {
  traceId?: string;
  spanId?: string;
  traceparent?: string;
  tracestate?: string;
  source?: string;
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
}

export interface WideEventPayloadInfo {
  sizeBytes: number;
  limited: boolean;
  maxBytes?: number;
  strategy?: "truncate" | "drop" | "error";
}

export interface WideEvent {
  id: string;
  name: string;
  kind: WideEventKind;
  service?: string;
  environment?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: WideEventOutcome;
  status?: number | string;
  sampled: boolean;
  sampling: WideEventSamplingDecision;
  payload?: WideEventPayloadInfo;
  traceId?: string;
  spanId?: string;
  traceparent?: string;
  tracestate?: string;
  traceSource?: string;
  data: WideEventData;
  errors: WideEventError[];
}

export type WideEventSamplerResult = boolean | WideEventSamplingDecision;

export type WideEventSampler = (
  event: Omit<WideEvent, "sampled" | "sampling">,
) => WideEventSamplerResult | Promise<WideEventSamplerResult>;

export type WideEventDrain = (event: WideEvent) => void | Promise<void>;

export type WideEventEmitter = WideEventDrain;

export interface WideEventEnrichContext {
  event: Omit<WideEvent, "sampled" | "sampling">;
}

export type WideEventEnricher = (context: WideEventEnrichContext) => void | Promise<void>;

export interface WideEventPayloadPolicy {
  maxBytes: number;
  overflowStrategy?: "truncate" | "drop" | "error";
  truncatePlaceholder?: string;
}

export type WideEventFilterResult = boolean | WideEventSamplingDecision;

export type WideEventFilter = (input: StartWideEventInput) => WideEventFilterResult;

export type WideEventTraceContextExtractor = (
  input: StartWideEventInput,
) => WideEventTraceContext | undefined;

export interface WideEventRuntimeConfig {
  service?: string;
  environment?: string;
  filter?: WideEventFilter;
  sampler?: WideEventSampler;
  enrichers?: WideEventEnricher[];
  drains?: WideEventDrain[];
  emitters?: WideEventEmitter[];
  payloadPolicy?: WideEventPayloadPolicy;
  traceContextExtractor?: WideEventTraceContextExtractor;
  emitTimeoutMs?: number;
  now?: () => Date;
  idGenerator?: () => string;
  onEnricherError?: (
    error: unknown,
    event: Omit<WideEvent, "sampled" | "sampling">,
    enricherIndex: number,
  ) => void;
  onDrainError?: (error: unknown, event: WideEvent, drainIndex: number) => void;
  onEmitterError?: (error: unknown, event: WideEvent, emitterIndex: number) => void;
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
  outcome?: WideEventOutcome;
  status?: number | string;
  data?: WideEventData;
  samplingDecision?: WideEventSamplingDecision;
}

export interface WithWideEventOptions {
  autoEmit?: boolean;
  emitOnError?: boolean;
  emitTimeoutMs?: number;
  successOutcome?: Exclude<WideEventOutcome, "error">;
}

export interface WideEventErrorDetails {
  why?: string;
  fix?: string;
  link?: string;
  code?: string | number;
}
