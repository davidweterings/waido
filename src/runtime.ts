import { AsyncLocalStorage } from "node:async_hooks";

import { createConsoleDrain } from "#src/drains.js";
import { noopWideEvent, ActiveWideEvent } from "#src/active-event.js";
import { DEFAULT_MAX_BYTES } from "#src/payload.js";
import { createSpanBinder, type TraceBinding } from "#src/tracing.js";
import type {
  StartWideEventInput,
  WideEvent,
  WideEventDrain,
  WideEventErrorContext,
  WideEventRuntimeConfig,
  WideEventSampler,
  WideEventTraceContext,
} from "#src/types.js";
import { createDefaultId } from "#src/utils.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;

interface Runtime {
  config: WideEventRuntimeConfig;
  sampler: WideEventSampler;
  drains: WideEventDrain[];
  now: () => Date;
  idGenerator: () => string;
  report: (error: unknown, context: WideEventErrorContext) => void;
  deliver: (event: WideEvent) => void;
  bindSpan: () => TraceBinding | undefined;
}

export interface FlushWideEventsOptions {
  timeoutMs?: number;
}

export interface FlushWideEventsResult {
  /** `false` if the timeout passed with work still in progress. */
  completed: boolean;
  /** Scopes and drains still in progress when the call returned. */
  pending: number;
}

export interface WideEventRuntimeHandle {
  flush(options?: FlushWideEventsOptions): Promise<FlushWideEventsResult>;
  /** Flushes, then shuts the runtime down, even if the flush timed out. */
  destroy(options?: FlushWideEventsOptions): Promise<FlushWideEventsResult>;
}

const storage = new AsyncLocalStorage<ActiveWideEvent>();
const pendingDrains = new Set<Promise<void>>();
const activeScopes = new Map<symbol, Promise<void>>();
let runtime: Runtime | undefined;

function startTimer(timeoutMs: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return timer;
}

function runDrain(
  drain: WideEventDrain,
  event: WideEvent,
  index: number,
  timeoutMs: number | undefined,
  report: Runtime["report"],
): Promise<void> {
  const context = { eventId: event.id, eventName: event.name, index };

  return new Promise<void>((resolve) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : startTimer(timeoutMs, () => {
            report(new Error(`Drain ${index} did not finish within ${timeoutMs}ms`), {
              ...context,
              stage: "drain_timeout",
            });
            resolve();
          });

    Promise.resolve()
      .then(() => drain(event))
      .catch((error: unknown) => {
        report(error, { ...context, stage: "drain" });
      })
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

function trackDrainWork(operation: Promise<void>): void {
  const tracked = operation.finally(() => {
    pendingDrains.delete(tracked);
  });
  pendingDrains.add(tracked);
}

function createRuntime(config: WideEventRuntimeConfig): Runtime {
  const { payloadPolicy, emitTimeoutMs, onError } = config;

  if (payloadPolicy?.maxBytes !== undefined) {
    if (!Number.isFinite(payloadPolicy.maxBytes) || payloadPolicy.maxBytes <= 0) {
      throw new RangeError(
        `payloadPolicy.maxBytes must be a positive number. Received: ${payloadPolicy.maxBytes}`,
      );
    }
  }

  if (emitTimeoutMs !== undefined && (!Number.isFinite(emitTimeoutMs) || emitTimeoutMs <= 0)) {
    throw new RangeError(`emitTimeoutMs must be a positive number. Received: ${emitTimeoutMs}`);
  }

  const drains = config.drains ?? [createConsoleDrain()];

  if (drains.some((drain) => typeof drain !== "function")) {
    throw new TypeError("Every drain must be a function");
  }

  const report: Runtime["report"] = (error, context) => {
    try {
      onError?.(error, context);
    } catch {
      // A failing error handler has nowhere left to report to.
    }
  };

  drains.forEach((drain, index) => {
    drain.start?.({
      report: (error) => {
        report(error, { stage: "drain", index });
      },
    });
  });

  return {
    config: {
      ...config,
      environment: config.environment ?? process.env.NODE_ENV,
      payloadPolicy: { maxBytes: DEFAULT_MAX_BYTES, ...payloadPolicy },
    },
    sampler: config.sampler ?? (() => ({ sampled: true, reason: "default_keep" })),
    drains,
    now: config.now ?? (() => new Date()),
    idGenerator: config.idGenerator ?? createDefaultId,
    report,
    deliver: (event) => {
      drains.forEach((drain, index) => {
        trackDrainWork(runDrain(drain, event, index, emitTimeoutMs, report));
      });
    },
    bindSpan: createSpanBinder({ enrichSpans: config.enrichSpans ?? true }),
  };
}

function definedFields(context: WideEventTraceContext | undefined): WideEventTraceContext {
  return Object.fromEntries(
    Object.entries(context ?? {}).filter(([, value]) => value !== undefined),
  );
}

/**
 * Merges trace context from least to most authoritative. A layer naming a different trace replaces
 * what came before, since those span IDs would belong to the wrong trace.
 */
function mergeTraceContexts(
  ...layers: Array<WideEventTraceContext | undefined>
): WideEventTraceContext | undefined {
  let merged: WideEventTraceContext = {};

  for (const layer of layers) {
    const fields = definedFields(layer);
    const conflicts =
      fields.traceId !== undefined &&
      merged.traceId !== undefined &&
      fields.traceId !== merged.traceId;
    merged = conflicts ? fields : { ...merged, ...fields };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function inheritTraceContext(parent: ActiveWideEvent | undefined): WideEventTraceContext {
  const trace = parent?.getTraceContext();

  return {
    traceId: trace?.traceId,
    traceSampled: trace?.traceSampled,
    parentSpanId: trace?.spanId ?? trace?.parentSpanId,
  };
}

function isFilteredOut(current: Runtime, input: StartWideEventInput): boolean {
  try {
    return current.config.filter?.(input) === false;
  } catch (error) {
    current.report(error, { stage: "filter", eventName: input.name });
    return false;
  }
}

function bindToSpan(current: Runtime, input: StartWideEventInput): TraceBinding | undefined {
  try {
    return current.bindSpan();
  } catch (error) {
    current.report(error, { stage: "tracing", eventName: input.name });
    return undefined;
  }
}

/** Sends anything a drain is still holding, such as a partly filled batch. */
function flushDrains(current: Runtime): void {
  current.drains.forEach((drain, index) => {
    if (drain.flush === undefined) {
      return;
    }

    trackDrainWork(
      Promise.resolve()
        .then(() => drain.flush?.())
        .catch((error: unknown) => {
          current.report(error, { stage: "drain", index });
        }),
    );
  });
}

function extractTraceContext(
  current: Runtime,
  input: StartWideEventInput,
): WideEventTraceContext | undefined {
  try {
    return current.config.traceContextExtractor?.(input);
  } catch (error) {
    current.report(error, { stage: "trace_context", eventName: input.name });
    return undefined;
  }
}

/** Sets up a runtime for this process, replacing any previous configuration. */
export function initWaido(config: WideEventRuntimeConfig = {}): WideEventRuntimeHandle {
  const created = createRuntime(config);
  const previous = runtime;
  runtime = created;

  if (previous !== undefined) {
    flushDrains(previous);
  }

  return {
    flush: (options) => flushWideEvents(options),
    destroy: async (options) => {
      const result = await flushWideEvents(options);
      if (runtime === created) {
        runtime = undefined;
      }

      return result;
    },
  };
}

/**
 * Starts an event without putting it in context, for building custom adapters. Returns a no-op
 * event when the runtime isn't initialized or the `filter` rejects the input.
 */
export function createWideEvent(input: StartWideEventInput): ActiveWideEvent {
  const current = runtime;
  if (current === undefined || isFilteredOut(current, input)) {
    return noopWideEvent;
  }

  const store = storage.getStore();
  const parent = store === noopWideEvent ? undefined : store;
  const traceBinding = bindToSpan(current, input);

  return new ActiveWideEvent(
    {
      sampler: current.sampler,
      enrichers: current.config.enrichers ?? [],
      redact: current.config.redact,
      payloadPolicy: current.config.payloadPolicy,
      now: current.now,
      traceBinding,
      deliver: current.deliver,
      report: current.report,
    },
    {
      ...input,
      traceContext: mergeTraceContexts(
        inheritTraceContext(parent),
        input.traceContext,
        extractTraceContext(current, input),
        traceBinding?.traceContext,
      ),
      id: current.idGenerator(),
      parentId: parent?.id,
      startedAt: current.now(),
      service: current.config.service,
      environment: current.config.environment,
    },
  );
}

export function runWithWideEvent<T>(event: ActiveWideEvent, work: () => T): T {
  return storage.run(event, work);
}

export function useWideEvent(): ActiveWideEvent {
  return storage.getStore() ?? noopWideEvent;
}

/** Reports a failure from an adapter's user-supplied callback to `onError`. */
export function reportAdapterError(error: unknown): void {
  runtime?.report(error, { stage: "adapter" });
}

/** Makes `flush()` wait for a unit of work. Call the returned function when it ends. */
export function startWideEventScope(): () => void {
  const token = Symbol("wide-event-scope");
  let resolve!: () => void;

  activeScopes.set(
    token,
    new Promise<void>((done) => {
      resolve = done;
    }),
  );

  return () => {
    if (activeScopes.delete(token)) {
      resolve();
    }
  };
}

/**
 * Runs `work` with a wide event in context, then emits the event. Returns or rethrows exactly what
 * `work` does: a telemetry failure can't change the result.
 */
export async function withWideEvent<T>(
  input: StartWideEventInput,
  work: (event: ActiveWideEvent) => Promise<T> | T,
): Promise<T> {
  const event = createWideEvent(input);
  const closeScope = startWideEventScope();

  return storage.run(event, async () => {
    try {
      const value = await work(event);
      event.emit();
      return value;
    } catch (error) {
      if (!event.hasEmitted()) {
        event.addError(error);
        event.emit();
      }

      throw error;
    } finally {
      closeScope();
    }
  });
}

function pendingWork(): Promise<unknown>[] {
  return [...activeScopes.values(), ...pendingDrains];
}

async function waitForPendingWork(deadline: number): Promise<void> {
  while (activeScopes.size > 0 || pendingDrains.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pendingWork()),
      // This timer stays referenced: if only stuck work remains, the process has to stay alive long
      // enough for the flush to report it, rather than exiting from under the caller.
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
    ]);
    clearTimeout(timer);
  }
}

/**
 * Waits for in-flight scopes and drains, including anything drains are batching. Never rejects:
 * check `completed` to see whether everything finished in time.
 */
export async function flushWideEvents(
  options: FlushWideEventsOptions = {},
): Promise<FlushWideEventsResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  await waitForPendingWork(deadline);

  // Finished work has now reached the drains, so whatever they are holding can be sent.
  if (runtime !== undefined) {
    flushDrains(runtime);
  }

  await waitForPendingWork(deadline);

  const pending = activeScopes.size + pendingDrains.size;
  return { completed: pending === 0, pending };
}

export function __resetWideEventsForTests(): void {
  runtime = undefined;
  activeScopes.clear();
  pendingDrains.clear();
}
