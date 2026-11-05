import { normalizeError } from "#src/error.js";
import { applyPayloadPolicy } from "#src/payload.js";
import { normalizeSamplingDecision } from "#src/sampler.js";
import type {
  EmitWideEventInput,
  StartWideEventInput,
  WideEvent,
  WideEventCandidate,
  WideEventData,
  WideEventDraft,
  WideEventEnricher,
  WideEventError,
  WideEventErrorContext,
  WideEventErrorDetails,
  WideEventIntegrationScope,
  WideEventKind,
  WideEventOutcome,
  WideEventPayloadPolicy,
  WideEventRedactor,
  WideEventSampler,
  WideEventSamplingDecision,
  WideEventTraceContext,
} from "#src/types.js";
import { deepMerge, isPlainObject, isUnsafeKey, readOwn, sanitizeData } from "#src/utils.js";

const MAX_ERRORS = 10;

export interface LoggerDependencies {
  sampler: WideEventSampler;
  enrichers: WideEventEnricher[];
  redact?: WideEventRedactor;
  payloadPolicy?: WideEventPayloadPolicy;
  now: () => Date;
  scopes: WideEventIntegrationScope[];
  deliver: (event: WideEvent) => void;
  report: (error: unknown, context: WideEventErrorContext) => void;
}

export interface LoggerInit extends StartWideEventInput {
  id: string;
  parentId?: string;
  startedAt: Date;
  service?: string;
  environment?: string;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

export class WideEventLogger {
  private readonly id_: string;
  private readonly parentId?: string;
  private name: string;
  private readonly kind: WideEventKind;
  private readonly service?: string;
  private readonly environment?: string;
  private readonly startedAt: Date;
  private status?: number | string;
  private explicitOutcome?: WideEventOutcome;
  private samplingDecision?: WideEventSamplingDecision;
  private traceContext?: WideEventTraceContext;
  private readonly data: WideEventData;
  private readonly errors: WideEventError[] = [];
  private errorsDropped = 0;
  private readonly recordedErrors = new WeakSet<object>();
  private readonly timers = new Map<string, Date>();
  private emitted = false;
  private lateWriteReported = false;
  private result: WideEvent | undefined;

  public constructor(
    private readonly dependencies: LoggerDependencies,
    init: LoggerInit,
  ) {
    this.id_ = init.id;
    this.parentId = init.parentId;
    this.name = init.name;
    this.kind = init.kind ?? "custom";
    this.service = init.service;
    this.environment = init.environment;
    this.startedAt = init.startedAt;
    this.status = init.status;
    this.samplingDecision = init.samplingDecision;
    this.traceContext = init.traceContext;
    this.data = {};
    this.mergeFields(init.data);
  }

  public get id(): string {
    return this.id_;
  }

  /** The trace context this event carries. */
  public getTraceContext(): Readonly<WideEventTraceContext> | undefined {
    return this.traceContext;
  }

  public set(key: string, value: unknown): this {
    if (this.acceptsWrite("set") && !isUnsafeKey(key)) {
      this.data[key] = value;
    }

    return this;
  }

  public setFields(patch: WideEventData): this;
  public setFields(key: string, patch: WideEventData): this;
  public setFields(keyOrPatch: string | WideEventData, maybePatch?: WideEventData): this {
    if (!this.acceptsWrite("setFields")) {
      return this;
    }

    if (typeof keyOrPatch !== "string") {
      this.mergeFields(keyOrPatch);
      return this;
    }

    if (isUnsafeKey(keyOrPatch)) {
      return this;
    }

    const existing = readOwn(this.data, keyOrPatch);
    const target = isPlainObject(existing) ? existing : {};
    this.data[keyOrPatch] = target;
    this.mergeFields(maybePatch, target);
    return this;
  }

  public increment(key: string, amount = 1): this {
    if (this.acceptsWrite("increment") && !isUnsafeKey(key)) {
      const current = readOwn(this.data, key);
      this.data[key] = (typeof current === "number" ? current : 0) + amount;
    }

    return this;
  }

  public append(key: string, value: unknown): this {
    if (this.acceptsWrite("append") && !isUnsafeKey(key)) {
      const current = readOwn(this.data, key);
      const list = Array.isArray(current) ? current : [];
      list.push(value);
      this.data[key] = list;
    }

    return this;
  }

  public time(label: string): this {
    if (this.acceptsWrite("time")) {
      this.timers.set(label, this.dependencies.now());
    }

    return this;
  }

  public timeEnd(label: string): this {
    if (!this.acceptsWrite("timeEnd")) {
      return this;
    }

    const start = this.timers.get(label);
    if (start === undefined || isUnsafeKey(label)) {
      return this;
    }

    this.timers.delete(label);
    const durationMs = Math.max(0, this.dependencies.now().getTime() - start.getTime());
    const existing = readOwn(this.data, "timings");
    const timings = isPlainObject(existing) ? existing : {};
    timings[label] = durationMs;
    this.data.timings = timings;
    return this;
  }

  public setStatus(status: number | string): this {
    if (this.acceptsWrite("setStatus")) {
      this.status = status;
    }

    return this;
  }

  /** Sets the outcome explicitly. This takes priority over recorded errors and the status. */
  public setOutcome(outcome: WideEventOutcome): this {
    if (this.acceptsWrite("setOutcome")) {
      this.explicitOutcome = outcome;
    }

    return this;
  }

  public setTraceContext(traceContext: WideEventTraceContext): this {
    if (this.acceptsWrite("setTraceContext")) {
      this.traceContext = {
        ...this.traceContext,
        ...traceContext,
      };
    }

    return this;
  }

  /** Forces the sampling decision, overriding the configured sampler. */
  public setSamplingDecision(samplingDecision: WideEventSamplingDecision): this {
    if (this.acceptsWrite("setSamplingDecision")) {
      this.samplingDecision = samplingDecision;
    }

    return this;
  }

  /** Records an error, which makes the outcome `error` unless `setOutcome()` says otherwise. */
  public error(error: unknown, patch?: WideEventData, details?: WideEventErrorDetails): this {
    if (!this.acceptsWrite("error")) {
      return this;
    }

    this.recordError(error, details);

    if (patch !== undefined) {
      this.mergeFields(patch);
    }

    return this;
  }

  public hasEmitted(): boolean {
    return this.emitted;
  }

  /**
   * Finalizes the event and hands it to the drains in the background. Later calls have no effect.
   * Returns the event if it was kept, or `undefined` if it was sampled out.
   */
  public emit(input: EmitWideEventInput = {}): WideEvent | undefined {
    if (this.emitted) {
      return this.result;
    }

    this.mergeFields(input.data);
    this.name = input.name ?? this.name;
    this.status = input.status ?? this.status;
    this.explicitOutcome = input.outcome ?? this.explicitOutcome;
    this.samplingDecision = input.samplingDecision ?? this.samplingDecision;
    this.emitted = true;

    try {
      this.result = this.finalize(input.aborted === true);
    } catch (error) {
      this.report(error, "internal");
    }

    return this.result;
  }

  private finalize(aborted: boolean): WideEvent | undefined {
    const draft = this.sanitizeDraft(this.applyEnrichers(this.createDraft(aborted)));
    this.applyRedaction(draft);

    const payload = applyPayloadPolicy(draft, this.dependencies.payloadPolicy);
    const candidate: WideEventCandidate = { ...draft, payload };

    this.dependencies.scopes.forEach((scope, index) => {
      try {
        scope.onFinalize?.(candidate);
      } catch (error) {
        this.report(error, "integration", index);
      }
    });

    const decision = this.resolveSamplingDecision(candidate);
    if (!decision.sampled) {
      return undefined;
    }

    const event: WideEvent = {
      ...candidate,
      sampling: {
        reason: decision.reason,
        rule: decision.rule,
        sampleRate: decision.sampleRate ?? 1,
      },
    };

    this.dependencies.deliver(event);
    return event;
  }

  private createDraft(aborted: boolean): WideEventDraft {
    const endedAt = this.dependencies.now();

    return {
      id: this.id_,
      parentId: this.parentId,
      name: this.name,
      kind: this.kind,
      service: this.service,
      environment: this.environment,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      outcome: this.resolveOutcome(aborted),
      status: this.status,
      traceId: this.traceContext?.traceId,
      spanId: this.traceContext?.spanId,
      parentSpanId: this.traceContext?.parentSpanId,
      traceSampled: this.traceContext?.traceSampled,
      data: sanitizeData(this.data),
      errors: this.errors.map((error) => ({ ...error })),
      errorsDropped: this.errorsDropped > 0 ? this.errorsDropped : undefined,
    };
  }

  /**
   * Copies the event after enrichers have run, so whatever they added can't break serialization and
   * a late write from an async enricher can't slip past redaction.
   */
  private sanitizeDraft(draft: WideEventDraft): WideEventDraft {
    const sanitized = sanitizeData(draft) as WideEventDraft;
    sanitized.data = isPlainObject(sanitized.data) ? sanitized.data : {};
    sanitized.errors = Array.isArray(sanitized.errors) ? sanitized.errors : [];
    return sanitized;
  }

  private resolveOutcome(aborted: boolean): WideEventOutcome {
    if (this.explicitOutcome !== undefined) {
      return this.explicitOutcome;
    }

    if (this.errors.length > 0) {
      return "error";
    }

    if (aborted) {
      return "aborted";
    }

    return typeof this.status === "number" && this.status >= 500 ? "error" : "success";
  }

  private applyEnrichers(draft: WideEventDraft): WideEventDraft {
    this.dependencies.enrichers.forEach((enricher, index) => {
      try {
        const result: unknown = enricher({ event: draft });
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError("Enrichers must be synchronous. A returned promise was ignored.");
        }
      } catch (error) {
        this.report(error, "enricher", index);
      }
    });

    return draft;
  }

  /** Fails closed: if redaction breaks, sensitive fields must not reach a sink. */
  private applyRedaction(draft: WideEventDraft): void {
    if (this.dependencies.redact === undefined) {
      return;
    }

    try {
      this.dependencies.redact(draft.data);
    } catch (error) {
      draft.data = { __redactionFailed: true };
      this.report(error, "redact");
    }
  }

  /** Fails open: if a sampler breaks, keeping one extra event beats losing it. */
  private resolveSamplingDecision(event: WideEventCandidate): WideEventSamplingDecision {
    if (this.samplingDecision !== undefined) {
      return this.samplingDecision;
    }

    try {
      const result: unknown = this.dependencies.sampler(event);
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Samplers must be synchronous. A returned promise was ignored.");
      }

      return normalizeSamplingDecision(result as boolean | WideEventSamplingDecision);
    } catch (error) {
      this.report(error, "sampler");
      return { sampled: true, reason: "sampler_error" };
    }
  }

  private recordError(error: unknown, details: WideEventErrorDetails | undefined): void {
    if (typeof error === "object" && error !== null) {
      if (this.recordedErrors.has(error)) {
        return;
      }

      this.recordedErrors.add(error);
    }

    if (this.errors.length >= MAX_ERRORS) {
      this.errorsDropped += 1;
      return;
    }

    try {
      this.errors.push(normalizeError(error, details));
    } catch (normalizeFailure) {
      this.errors.push({ name: "UnreadableError", message: "The error could not be read" });
      this.report(normalizeFailure, "internal");
    }
  }

  /** Telemetry must not throw into the code being observed, whatever fields it is handed. */
  private mergeFields(patch: WideEventData | undefined, target: WideEventData = this.data): void {
    if (patch === undefined) {
      return;
    }

    try {
      deepMerge(target, patch);
    } catch (error) {
      this.report(error, "internal");
    }
  }

  private acceptsWrite(method: string): boolean {
    if (!this.emitted) {
      return true;
    }

    if (!this.lateWriteReported) {
      this.lateWriteReported = true;
      this.report(
        new Error(`log.${method}() was called after the event was emitted, so it was ignored`),
        "late_write",
      );
    }

    return false;
  }

  private report(error: unknown, stage: WideEventErrorContext["stage"], index?: number): void {
    this.dependencies.report(error, {
      stage,
      eventId: this.id_,
      eventName: this.name,
      index,
    });
  }
}

class NoopLogger extends WideEventLogger {
  public constructor() {
    super(
      {
        sampler: () => false,
        enrichers: [],
        now: () => new Date(0),
        scopes: [],
        deliver: () => undefined,
        report: () => undefined,
      },
      { id: "", name: "", startedAt: new Date(0) },
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
  public override emit(): undefined {
    return undefined;
  }
}

export const noopLogger: WideEventLogger = new NoopLogger();
