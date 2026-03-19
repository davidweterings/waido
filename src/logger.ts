import { normalizeError } from "#src/error.js";
import { applyPayloadPolicy } from "#src/payload.js";
import { normalizeSamplingDecision } from "#src/sampler.js";
import type {
  EmitWideEventInput,
  StartWideEventInput,
  WideEvent,
  WideEventData,
  WideEventDrain,
  WideEventEnricher,
  WideEventError,
  WideEventErrorDetails,
  WideEventKind,
  WideEventOutcome,
  WideEventPayloadPolicy,
  WideEventSampler,
  WideEventSamplingDecision,
  WideEventTraceContext,
} from "#src/types.js";
import { cloneData, deepMerge, isPlainObject } from "#src/utils.js";

interface LoggerDependencies {
  sampler: WideEventSampler;
  enrichers: WideEventEnricher[];
  drains: WideEventDrain[];
  payloadPolicy?: WideEventPayloadPolicy;
  now: () => Date;
  onEnricherError?: (
    error: unknown,
    event: Omit<WideEvent, "sampled" | "sampling">,
    enricherIndex: number,
  ) => void;
  onDrainError?: (error: unknown, event: WideEvent, drainIndex: number) => void;
  trackPending?: <T>(operation: Promise<T>) => Promise<T>;
}

interface LoggerInit extends StartWideEventInput {
  id: string;
  startedAt: Date;
  service?: string;
  environment?: string;
}

interface WideEventDraft {
  id: string;
  name: string;
  kind: WideEventKind;
  service?: string;
  environment?: string;
  startedAt: Date;
  status?: number | string;
  outcome?: WideEventOutcome;
  samplingDecision?: WideEventSamplingDecision;
  traceContext?: WideEventTraceContext;
  data: WideEventData;
  errors: WideEventError[];
}

export class WideEventLogger {
  private readonly draft: WideEventDraft;
  private readonly timers = new Map<string, Date>();
  private emittedEvent: WideEvent | undefined;
  private emittedPromise: Promise<WideEvent> | undefined;

  public constructor(
    private readonly dependencies: LoggerDependencies,
    init: LoggerInit,
  ) {
    this.draft = {
      id: init.id,
      name: init.name,
      kind: init.kind ?? "custom",
      service: init.service,
      environment: init.environment,
      startedAt: init.startedAt,
      status: init.status,
      samplingDecision: init.samplingDecision,
      traceContext: init.traceContext,
      data: cloneData(init.data),
      errors: [],
    };
  }

  public set(key: string, value: unknown): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.data[key] = value;
    return this;
  }

  public setFields(patch: WideEventData): this;
  public setFields(key: string, patch: WideEventData): this;
  public setFields(keyOrPatch: string | WideEventData, maybePatch?: WideEventData): this {
    if (this.isMutationLocked()) {
      return this;
    }

    if (typeof keyOrPatch === "string") {
      const existing = this.draft.data[keyOrPatch];
      if (isPlainObject(existing) && maybePatch) {
        deepMerge(existing, maybePatch);
      } else {
        this.draft.data[keyOrPatch] = maybePatch;
      }
    } else {
      deepMerge(this.draft.data, keyOrPatch);
    }

    return this;
  }

  public increment(key: string, amount = 1): this {
    if (this.isMutationLocked()) {
      return this;
    }

    const current = this.draft.data[key];
    this.draft.data[key] = (typeof current === "number" ? current : 0) + amount;
    return this;
  }

  public append(key: string, value: unknown): this {
    if (this.isMutationLocked()) {
      return this;
    }

    const current = this.draft.data[key];
    const list = Array.isArray(current) ? current : [];
    list.push(value);
    this.draft.data[key] = list;
    return this;
  }

  public time(label: string): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.timers.set(label, this.dependencies.now());
    return this;
  }

  public timeEnd(label: string): this {
    if (this.isMutationLocked()) {
      return this;
    }

    const start = this.timers.get(label);
    if (start === undefined) {
      return this;
    }

    this.timers.delete(label);
    const durationMs = Math.max(0, this.dependencies.now().getTime() - start.getTime());
    const timings = (this.draft.data.timings ?? {}) as Record<string, unknown>;
    timings[label] = durationMs;
    this.draft.data.timings = timings;
    return this;
  }

  public setStatus(status: number | string): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.status = status;
    return this;
  }

  public setOutcome(outcome: WideEventOutcome): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.outcome = outcome;
    return this;
  }

  public setTraceContext(traceContext: WideEventTraceContext): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.traceContext = {
      ...this.draft.traceContext,
      ...traceContext,
    };
    return this;
  }

  public setSamplingDecision(samplingDecision: WideEventSamplingDecision): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.samplingDecision = samplingDecision;
    return this;
  }

  public error(error: unknown, patch?: WideEventData, details?: WideEventErrorDetails): this {
    if (this.isMutationLocked()) {
      return this;
    }

    this.draft.errors.push(normalizeError(error, details));
    this.draft.outcome = "error";

    if (patch !== undefined) {
      this.setFields(patch);
    }

    return this;
  }

  public hasEmitted(): boolean {
    return this.emittedEvent !== undefined;
  }

  public toDraft(): Readonly<WideEventDraft> {
    return {
      ...this.draft,
      data: cloneData(this.draft.data),
      errors: this.draft.errors.map((e) => ({ ...e })),
      traceContext: this.draft.traceContext ? { ...this.draft.traceContext } : undefined,
      samplingDecision: this.draft.samplingDecision
        ? { ...this.draft.samplingDecision }
        : undefined,
    };
  }

  public emit(input: EmitWideEventInput = {}): Promise<WideEvent> {
    if (this.emittedEvent !== undefined) {
      return Promise.resolve(this.emittedEvent);
    }

    if (this.emittedPromise !== undefined) {
      return this.emittedPromise;
    }

    const operation = this.emitInternal(input);
    const tracked = this.dependencies.trackPending
      ? this.dependencies.trackPending(operation)
      : operation;

    this.emittedPromise = tracked;
    return tracked;
  }

  private async emitInternal(input: EmitWideEventInput): Promise<WideEvent> {
    if (input.data !== undefined) {
      this.setFields(input.data);
    }

    if (input.status !== undefined) {
      this.draft.status = input.status;
    }

    if (input.outcome !== undefined) {
      this.draft.outcome = input.outcome;
    }

    if (input.samplingDecision !== undefined) {
      this.draft.samplingDecision = input.samplingDecision;
    }

    const endedAt = this.dependencies.now();
    const durationMs = Math.max(0, endedAt.getTime() - this.draft.startedAt.getTime());
    const outcome = this.draft.outcome ?? (this.draft.errors.length > 0 ? "error" : "success");

    const eventWithoutSampling: Omit<WideEvent, "sampled" | "sampling"> = {
      id: this.draft.id,
      name: this.draft.name,
      kind: this.draft.kind,
      service: this.draft.service,
      environment: this.draft.environment,
      startedAt: this.draft.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      outcome,
      status: this.draft.status,
      traceId: this.draft.traceContext?.traceId,
      spanId: this.draft.traceContext?.spanId,
      traceparent: this.draft.traceContext?.traceparent,
      tracestate: this.draft.traceContext?.tracestate,
      traceSource: this.draft.traceContext?.source,
      data: cloneData(this.draft.data),
      errors: this.draft.errors.map((e) => ({ ...e })),
    };

    for (let index = 0; index < this.dependencies.enrichers.length; index += 1) {
      const enricher = this.dependencies.enrichers[index];

      try {
        await enricher({
          event: eventWithoutSampling,
        });
      } catch (error) {
        this.dependencies.onEnricherError?.(error, eventWithoutSampling, index);
      }
    }

    const payloadResult = applyPayloadPolicy(eventWithoutSampling, this.dependencies.payloadPolicy);
    eventWithoutSampling.payload = payloadResult.payload;
    if (payloadResult.error && eventWithoutSampling.errors.length === 0) {
      eventWithoutSampling.errors.push({
        name: payloadResult.error._tag,
        message: payloadResult.error.message,
      });
    }

    const samplingDecision = await this.resolveSamplingDecision(
      eventWithoutSampling,
      payloadResult.forcedSamplingDecision,
    );

    const event: WideEvent = {
      ...eventWithoutSampling,
      sampled: samplingDecision.sampled,
      sampling: samplingDecision,
    };

    this.emittedEvent = event;

    if (!event.sampled || this.dependencies.drains.length === 0) {
      return event;
    }

    const drainResults = await Promise.allSettled(
      this.dependencies.drains.map(async (drain) => drain(event)),
    );

    drainResults.forEach((result, drainIndex) => {
      if (result.status === "rejected") {
        this.dependencies.onDrainError?.(result.reason, event, drainIndex);
      }
    });

    return event;
  }

  private async resolveSamplingDecision(
    event: Omit<WideEvent, "sampled" | "sampling">,
    forcedDecision: WideEventSamplingDecision | undefined,
  ): Promise<WideEventSamplingDecision> {
    if (forcedDecision !== undefined) {
      return forcedDecision;
    }

    if (this.draft.samplingDecision !== undefined) {
      return this.draft.samplingDecision;
    }

    try {
      const samplerResult = await this.dependencies.sampler(event);
      return normalizeSamplingDecision(samplerResult);
    } catch (error) {
      return {
        sampled: false,
        reason: "sampler_error",
        rule: error instanceof Error ? error.message : "unknown",
      };
    }
  }

  private isMutationLocked(): boolean {
    return this.emittedEvent !== undefined || this.emittedPromise !== undefined;
  }
}

const noopEvent: WideEvent = {
  id: "",
  name: "",
  kind: "",
  startedAt: "",
  endedAt: "",
  durationMs: 0,
  outcome: "success",
  sampled: false,
  sampling: { sampled: false, reason: "noop" },
  data: {},
  errors: [],
};

class NoopLogger extends WideEventLogger {
  constructor() {
    super(
      {
        sampler: () => ({ sampled: false, reason: "noop" }),
        enrichers: [],
        drains: [],
        now: () => new Date(),
      },
      { id: "", name: "", startedAt: new Date() },
    );
  }

  public override set(): this {
    return this;
  }
  public override setFields(): this {
    return this;
  }
  public override increment(): this {
    return this;
  }
  public override append(): this {
    return this;
  }
  public override time(): this {
    return this;
  }
  public override timeEnd(): this {
    return this;
  }
  public override setStatus(): this {
    return this;
  }
  public override setOutcome(): this {
    return this;
  }
  public override setTraceContext(): this {
    return this;
  }
  public override setSamplingDecision(): this {
    return this;
  }
  public override error(): this {
    return this;
  }
  public override hasEmitted(): boolean {
    return false;
  }
  public override emit(): Promise<WideEvent> {
    return Promise.resolve(noopEvent);
  }
}

export const noopLogger: WideEventLogger = new NoopLogger();
