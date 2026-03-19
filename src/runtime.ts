import { AsyncLocalStorage } from "node:async_hooks";

import { Result } from "better-result";

import { noopLogger, WideEventLogger } from "#src/logger.js";
import {
  EmitWideEventTimeoutError,
  FlushWideEventsTimeoutError,
  type WideResult,
} from "#src/no-throw.js";
import { normalizeSamplingDecision } from "#src/sampler.js";
import type {
  EmitWideEventInput,
  StartWideEventInput,
  WideEvent,
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
  emitTimeoutMs?: number;
  now: NonNullable<WideEventRuntimeConfig["now"]>;
  idGenerator: NonNullable<WideEventRuntimeConfig["idGenerator"]>;
  onEnricherError?: WideEventRuntimeConfig["onEnricherError"];
  onDrainError?: WideEventRuntimeConfig["onDrainError"];
}

export interface FlushWideEventsOptions {
  timeoutMs?: number;
}

export interface WideEventRuntimeHandle {
  flush(options?: FlushWideEventsOptions): Promise<WideResult<void, FlushWideEventsTimeoutError>>;
  destroy(options?: FlushWideEventsOptions): Promise<WideResult<void, FlushWideEventsTimeoutError>>;
}

const storage = new AsyncLocalStorage<WideEventLogger>();
const pendingOperations = new Set<Promise<unknown>>();
const activeScopes = new Map<symbol, Promise<void>>();
let runtimeGeneration = 0;

const defaultState: RuntimeState = {
  service: undefined,
  environment: process.env.NODE_ENV,
  filter: undefined,
  sampler: () => ({ sampled: true, reason: "default_keep" }),
  enrichers: [],
  drains: [],
  payloadPolicy: undefined,
  traceContextExtractor: undefined,
  emitTimeoutMs: undefined,
  now: () => new Date(),
  idGenerator: createDefaultId,
  onEnricherError: undefined,
  onDrainError: undefined,
};

let state: RuntimeState = {
  ...defaultState,
};

function resetRuntimeState(): void {
  state = {
    ...defaultState,
  };
}

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

function startTimer(timeoutMs: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return timer;
}

function createTrackedScopeSummary(): {
  activeScopeCount: number;
  pendingOperationCount: number;
  trackedOperations: Promise<unknown>[];
} {
  return {
    activeScopeCount: activeScopes.size,
    pendingOperationCount: pendingOperations.size,
    trackedOperations: [...activeScopes.values(), ...pendingOperations],
  };
}

function formatTrackedScopeSummary(
  activeScopeCount: number,
  pendingOperationCount: number,
): string {
  const parts: string[] = [];

  if (activeScopeCount > 0) {
    parts.push(`${activeScopeCount} active wide event scope(s)`);
  }

  if (pendingOperationCount > 0) {
    parts.push(`${pendingOperationCount} pending wide event operation(s)`);
  }

  return parts.join(" and ") || "wide event work";
}

function createFlushTimeoutError(timeoutMs: number): FlushWideEventsTimeoutError {
  const { activeScopeCount, pendingOperationCount } = createTrackedScopeSummary();
  return new FlushWideEventsTimeoutError({
    timeoutMs,
    activeScopes: activeScopeCount,
    pendingOperations: pendingOperationCount,
    message: `Timed out waiting for ${formatTrackedScopeSummary(activeScopeCount, pendingOperationCount)} to flush`,
  });
}

async function waitForOperationWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  createTimeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = startTimer(timeoutMs, () => reject(createTimeoutError()));
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

export function initWaido(config: WideEventRuntimeConfig = {}): WideEventRuntimeHandle {
  const generation = ++runtimeGeneration;
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
    emitTimeoutMs: config.emitTimeoutMs ?? state.emitTimeoutMs,
    now: config.now ?? state.now,
    idGenerator: config.idGenerator ?? state.idGenerator,
    onEnricherError: config.onEnricherError ?? state.onEnricherError,
    onDrainError: config.onDrainError ?? config.onEmitterError ?? state.onDrainError,
  };

  return {
    flush: (options) => flushWideEvents(options),
    destroy: async (options) => {
      const result = await flushWideEvents(options);
      if (result.isErr()) {
        return result;
      }

      if (generation === runtimeGeneration) {
        runtimeGeneration += 1;
        resetRuntimeState();
      }

      return result;
    },
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

export function startWideEventScope(): () => void {
  const token = Symbol("wide-event-scope");
  let closed = false;
  let resolve!: () => void;

  const trackedScope = new Promise<void>((done) => {
    resolve = done;
  });

  activeScopes.set(token, trackedScope);

  return () => {
    if (closed) {
      return;
    }

    closed = true;
    activeScopes.delete(token);
    resolve();
  };
}

export async function awaitWideEventEmit(
  logger: WideEventLogger,
  input: EmitWideEventInput = {},
  options: { timeoutMs?: number } = {},
): Promise<WideEvent> {
  const operation = logger.emit(input);
  const timeoutMs = options.timeoutMs ?? state.emitTimeoutMs;

  if (timeoutMs === undefined) {
    return operation;
  }

  return waitForOperationWithTimeout(operation, timeoutMs, () => {
    const draft = logger.toDraft();

    return new EmitWideEventTimeoutError({
      timeoutMs,
      eventId: draft.id,
      eventName: draft.name,
      message: `Timed out waiting ${timeoutMs}ms for wide event "${draft.name}" to emit`,
    });
  });
}

export async function withWideContext<T>(
  input: StartWideEventInput,
  work: (logger: WideEventLogger) => Promise<T> | T,
  options: WithWideEventOptions = {},
): Promise<WideResult<T, unknown>> {
  const logger = createLogger(input);
  const closeScope = startWideEventScope();
  const autoEmit = options.autoEmit ?? true;
  const emitOnError = options.emitOnError ?? true;
  const successOutcome = options.successOutcome ?? "success";

  return storage.run(logger, async () => {
    try {
      const workResult = await Result.tryPromise({
        try: () => Promise.resolve(work(logger)),
        catch: (cause) => cause,
      });

      if (workResult.isOk()) {
        if (autoEmit && !logger.hasEmitted()) {
          const emitResult = await Result.tryPromise({
            try: () =>
              awaitWideEventEmit(
                logger,
                {
                  outcome: successOutcome,
                },
                {
                  timeoutMs: options.emitTimeoutMs,
                },
              ),
            catch: (cause) => cause,
          });

          if (emitResult.isErr()) {
            return Result.err(emitResult.error);
          }
        }

        return Result.ok(workResult.value);
      }

      if (!logger.hasEmitted()) {
        logger.error(workResult.error);
      }

      if (emitOnError && !logger.hasEmitted()) {
        await Result.tryPromise({
          try: () =>
            awaitWideEventEmit(
              logger,
              {
                outcome: "error",
              },
              {
                timeoutMs: options.emitTimeoutMs,
              },
            ),
          catch: () => undefined,
        });
      }

      return Result.err(workResult.error);
    } finally {
      closeScope();
    }
  });
}

export async function flushWideEvents(
  options: FlushWideEventsOptions = {},
): Promise<WideResult<void, FlushWideEventsTimeoutError>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (activeScopes.size > 0 || pendingOperations.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return Result.err(createFlushTimeoutError(timeoutMs));
    }

    let timer: ReturnType<typeof setTimeout>;
    const { trackedOperations } = createTrackedScopeSummary();
    const timedOut = await Promise.race([
      Promise.allSettled(trackedOperations).then(() => {
        clearTimeout(timer);
        return false as const;
      }),
      new Promise<true>((resolve) => {
        timer = startTimer(remainingMs, () => resolve(true));
      }),
    ]);

    if (timedOut) {
      return Result.err(createFlushTimeoutError(timeoutMs));
    }
  }

  return Result.ok();
}

export function __resetWideEventsForTests(): void {
  runtimeGeneration = 0;
  resetRuntimeState();
  activeScopes.clear();
  pendingOperations.clear();
}
