import { AsyncLocalStorage } from "node:async_hooks";

import { Result } from "better-result";

import { noopLogger, WideEventLogger } from "#src/logger.js";
import { FlushWideEventsTimeoutError, type WideResult } from "#src/no-throw.js";
import { normalizeSamplingDecision } from "#src/sampler.js";
import type {
  StartWideEventInput,
  WideEventDrain,
  WideEventRuntimeConfig,
  WideEventSamplingDecision,
  WideEventTraceContext,
  WithWideEventOptions,
} from "#src/types.js";
import { createDefaultId } from "#src/utils.js";

interface RuntimeState {
  service?: string;
  environment?: string;
  filter?: WideEventRuntimeConfig["filter"];
  sampler: NonNullable<WideEventRuntimeConfig["sampler"]>;
  enrichers: NonNullable<WideEventRuntimeConfig["enrichers"]>;
  drains: WideEventDrain[];
  payloadPolicy?: WideEventRuntimeConfig["payloadPolicy"];
  traceContextExtractor?: WideEventRuntimeConfig["traceContextExtractor"];
  now: NonNullable<WideEventRuntimeConfig["now"]>;
  idGenerator: NonNullable<WideEventRuntimeConfig["idGenerator"]>;
  onEnricherError?: WideEventRuntimeConfig["onEnricherError"];
  onDrainError?: WideEventRuntimeConfig["onDrainError"];
}

export interface FlushWideEventsOptions {
  timeoutMs?: number;
}

const storage = new AsyncLocalStorage<WideEventLogger>();
const pendingOperations = new Set<Promise<unknown>>();

const defaultState: RuntimeState = {
  service: undefined,
  environment: process.env.NODE_ENV,
  filter: undefined,
  sampler: () => ({ sampled: true, reason: "default_keep" }),
  enrichers: [],
  drains: [],
  payloadPolicy: undefined,
  traceContextExtractor: undefined,
  now: () => new Date(),
  idGenerator: createDefaultId,
  onEnricherError: undefined,
  onDrainError: undefined,
};

let state: RuntimeState = {
  ...defaultState,
};

function combineSamplingDecisions(
  ...decisions: Array<WideEventSamplingDecision | undefined>
): WideEventSamplingDecision | undefined {
  let lastKeepDecision: WideEventSamplingDecision | undefined;

  for (const decision of decisions) {
    if (decision === undefined) {
      continue;
    }

    if (!decision.sampled) {
      return decision;
    }

    lastKeepDecision = decision;
  }

  return lastKeepDecision;
}

function normalizeFilterDecision(
  result: ReturnType<NonNullable<WideEventRuntimeConfig["filter"]>>,
): WideEventSamplingDecision {
  if (typeof result === "boolean") {
    return {
      sampled: result,
      reason: result ? "filter_keep" : "filtered_out",
    };
  }

  return normalizeSamplingDecision(result);
}

function mergeTraceContexts(
  extracted: WideEventTraceContext | undefined,
  input: WideEventTraceContext | undefined,
): WideEventTraceContext | undefined {
  const merged = {
    ...extracted,
    ...input,
  };

  if (
    merged.traceId === undefined &&
    merged.spanId === undefined &&
    merged.traceparent === undefined &&
    merged.tracestate === undefined &&
    merged.source === undefined
  ) {
    return undefined;
  }

  return merged;
}

function trackPending<T>(operation: Promise<T>): Promise<T> {
  const tracked = operation.finally(() => {
    pendingOperations.delete(tracked);
  });

  pendingOperations.add(tracked);
  void tracked.catch(() => {
    // Keep unawaited emit failures from surfacing as unhandled promise rejections.
  });
  return tracked;
}

function createLogger(input: StartWideEventInput): WideEventLogger {
  const filterDecision = state.filter
    ? Result.try(() => normalizeFilterDecision(state.filter!(input))).match({
        ok: (value) => value,
        err: (error) => ({
          sampled: false,
          reason: "filter_error",
          rule: error.message,
        }),
      })
    : undefined;

  const samplingDecision = combineSamplingDecisions(input.samplingDecision, filterDecision);

  const extractedTraceContext = state.traceContextExtractor
    ? Result.try(() => state.traceContextExtractor!(input)).match({
        ok: (value) => value,
        err: () => undefined,
      })
    : undefined;

  const traceContext = mergeTraceContexts(extractedTraceContext, input.traceContext);

  return new WideEventLogger(
    {
      sampler: state.sampler,
      enrichers: [...state.enrichers],
      drains: [...state.drains],
      payloadPolicy: state.payloadPolicy,
      now: state.now,
      onEnricherError: state.onEnricherError,
      onDrainError: state.onDrainError,
      trackPending,
    },
    {
      ...input,
      traceContext,
      samplingDecision,
      id: state.idGenerator(),
      startedAt: state.now(),
      service: state.service,
      environment: state.environment,
    },
  );
}

export function initWaido(config: WideEventRuntimeConfig = {}): void {
  const nextDrains =
    config.drains !== undefined
      ? [...config.drains]
      : config.emitters !== undefined
        ? [...config.emitters]
        : [...state.drains];

  state = {
    ...state,
    service: config.service ?? state.service,
    environment: config.environment ?? state.environment,
    filter: config.filter ?? state.filter,
    sampler: config.sampler ?? state.sampler,
    enrichers: config.enrichers ? [...config.enrichers] : [...state.enrichers],
    drains: nextDrains,
    payloadPolicy: config.payloadPolicy ?? state.payloadPolicy,
    traceContextExtractor: config.traceContextExtractor ?? state.traceContextExtractor,
    now: config.now ?? state.now,
    idGenerator: config.idGenerator ?? state.idGenerator,
    onEnricherError: config.onEnricherError ?? state.onEnricherError,
    onDrainError: config.onDrainError ?? config.onEmitterError ?? state.onDrainError,
  };
}

export function setWideEventDrains(drains: WideEventDrain[]): void {
  state.drains = [...drains];
}

export function addWideEventDrain(drain: WideEventDrain): void {
  state.drains = [...state.drains, drain];
}

export function setWideEventEmitters(emitters: WideEventDrain[]): void {
  setWideEventDrains(emitters);
}

export function addWideEventEmitter(emitter: WideEventDrain): void {
  addWideEventDrain(emitter);
}

export function setWideEventEnrichers(
  enrichers: NonNullable<WideEventRuntimeConfig["enrichers"]>,
): void {
  state.enrichers = [...enrichers];
}

export function addWideEventEnricher(
  enricher: NonNullable<WideEventRuntimeConfig["enrichers"]>[number],
): void {
  state.enrichers = [...state.enrichers, enricher];
}

export function createWideEventLogger(input: StartWideEventInput): WideEventLogger {
  return createLogger(input);
}

export function runWithLoggerContext<T>(logger: WideEventLogger, work: () => T): T {
  return storage.run(logger, work);
}

export function useLogger(): WideEventLogger {
  return storage.getStore() ?? noopLogger;
}

export async function withWideContext<T>(
  input: StartWideEventInput,
  work: (logger: WideEventLogger) => Promise<T> | T,
  options: WithWideEventOptions = {},
): Promise<WideResult<T, unknown>> {
  const logger = createLogger(input);
  const autoEmit = options.autoEmit ?? true;
  const emitOnError = options.emitOnError ?? true;
  const successOutcome = options.successOutcome ?? "success";

  return storage.run(logger, async () => {
    const workResult = await Result.tryPromise({
      try: () => Promise.resolve(work(logger)),
      catch: (cause) => cause,
    });

    if (workResult.isOk()) {
      if (autoEmit && !logger.hasEmitted()) {
        await logger.emit({
          outcome: successOutcome,
        });
      }

      return Result.ok(workResult.value);
    }

    if (!logger.hasEmitted()) {
      logger.error(workResult.error);
    }

    if (emitOnError && !logger.hasEmitted()) {
      await logger.emit({
        outcome: "error",
      });
    }

    return Result.err(workResult.error);
  });
}

export async function flushWideEvents(
  options: FlushWideEventsOptions = {},
): Promise<WideResult<void, FlushWideEventsTimeoutError>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (pendingOperations.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return Result.err(
        new FlushWideEventsTimeoutError({
          timeoutMs,
          pendingOperations: pendingOperations.size,
          message: `Timed out waiting for ${pendingOperations.size} pending wide event operation(s) to flush`,
        }),
      );
    }

    let timer: ReturnType<typeof setTimeout>;
    const timedOut = await Promise.race([
      Promise.allSettled(Array.from(pendingOperations)).then(() => {
        clearTimeout(timer);
        return false as const;
      }),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), remainingMs);
      }),
    ]);

    if (timedOut) {
      return Result.err(
        new FlushWideEventsTimeoutError({
          timeoutMs,
          pendingOperations: pendingOperations.size,
          message: `Timed out waiting for ${pendingOperations.size} pending wide event operation(s) to flush`,
        }),
      );
    }
  }

  return Result.ok();
}

export function __resetWideEventsForTests(): void {
  state = {
    ...defaultState,
  };
  pendingOperations.clear();
}
