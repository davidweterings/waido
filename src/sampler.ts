import type {
  WideEventCandidate,
  WideEventKeepRule,
  WideEventSampler,
  WideEventSamplerResult,
  WideEventSamplingDecision,
} from "#src/types.js";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const RANDOMNESS_RANGE = 2 ** 56;

export interface TailSamplerOptions {
  /** An event matching any rule is always kept. */
  keep?: WideEventKeepRule[];
  /** Fraction of the remaining events to keep, from 0 to 1. */
  rate: number;
  /** Used only for events with no trace ID. */
  random?: () => number;
}

function assertValidRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`Sampler rate must be between 0 and 1. Received: ${rate}`);
  }
}

/**
 * Applies OpenTelemetry's consistent probability sampling: the last 7 bytes of the trace ID are
 * compared with a rejection threshold of `(1 - rate) * 2^56`. Services using the same rate therefore
 * keep or drop the same traces. An explicit `rv` value in `tracestate` is not consulted.
 */
function passesRate(rate: number, traceId: string | undefined, random: () => number): boolean {
  if (rate >= 1) {
    return true;
  }

  if (rate <= 0) {
    return false;
  }

  if (traceId !== undefined && TRACE_ID_REGEX.test(traceId)) {
    const randomness = BigInt(`0x${traceId.slice(-14)}`);
    return randomness >= BigInt(Math.round((1 - rate) * RANDOMNESS_RANGE));
  }

  return random() < rate;
}

function toSampleRate(rate: number): number {
  return rate > 0 ? Math.max(1, Math.round(1 / rate)) : 1;
}

function decideByRate(
  event: WideEventCandidate,
  rate: number,
  random: () => number,
  reasonPrefix: string,
  rule: string,
): WideEventSamplingDecision {
  const sampled = passesRate(rate, event.traceId, random);
  return {
    sampled,
    reason: `${reasonPrefix}_${sampled ? "keep" : "drop"}`,
    rule,
    sampleRate: toSampleRate(rate),
  };
}

function namedRule(ruleName: string, rule: WideEventKeepRule): WideEventKeepRule {
  rule.ruleName = ruleName;
  return rule;
}

/** Keeps events whose outcome is `error`. */
export function errors(): WideEventKeepRule {
  return namedRule("errors", (event) => event.outcome === "error");
}

/** Keeps events that took longer than `durationMs`. */
export function slowerThan(durationMs: number): WideEventKeepRule {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`slowerThan requires a non-negative duration. Received: ${durationMs}`);
  }

  return namedRule(`slower_than:${durationMs}`, (event) => event.durationMs > durationMs);
}

/** Keeps events whose incoming trace was marked as sampled. */
export function traceSampled(): WideEventKeepRule {
  return namedRule("trace_sampled", (event) => event.traceSampled === true);
}

/**
 * Decides after the work has finished: keeps anything matching a `keep` rule, then samples the rest
 * at `rate`. Kept-by-rule events record a sample rate of 1, sampled ones 1-in-N.
 */
export function createTailSampler(options: TailSamplerOptions): WideEventSampler {
  const { keep = [], rate, random = Math.random } = options;
  assertValidRate(rate);

  for (const rule of keep) {
    if (typeof rule !== "function") {
      throw new TypeError("createTailSampler keep rules must be functions");
    }
  }

  return (event) => {
    for (let index = 0; index < keep.length; index += 1) {
      const rule = keep[index];
      if (rule(event)) {
        return {
          sampled: true,
          reason: "keep_rule",
          rule: rule.ruleName ?? (rule.name || `keep[${index}]`),
          sampleRate: 1,
        };
      }
    }

    return decideByRate(event, rate, random, "rate", `rate:${rate}`);
  };
}

export function createRateSampler(
  rate: number,
  random: () => number = Math.random,
): WideEventSampler {
  assertValidRate(rate);
  return (event) => decideByRate(event, rate, random, "rate", `rate:${rate}`);
}

export function createNameRateSampler(
  ratesByName: Record<string, number>,
  fallbackRate = 1,
  random: () => number = Math.random,
): WideEventSampler {
  assertValidRate(fallbackRate);
  Object.values(ratesByName).forEach(assertValidRate);

  return (event) => {
    const rate = Object.hasOwn(ratesByName, event.name) ? ratesByName[event.name] : fallbackRate;
    return decideByRate(event, rate, random, "name_rate", `${event.name}:${rate}`);
  };
}

export function normalizeSamplingDecision(
  result: WideEventSamplerResult,
): WideEventSamplingDecision {
  if (typeof result === "boolean") {
    return {
      sampled: result,
      reason: result ? "sampler_keep" : "sampler_drop",
    };
  }

  return result;
}
