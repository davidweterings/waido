import { Result } from "better-result";

import { InvalidSamplerRateError } from "#src/no-throw.js";
import type {
  WideEventSampler,
  WideEventSamplerResult,
  WideEventSamplingDecision
} from "#src/types.js";

function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 1;
}

export function createRateSamplerResult(
  rate: number,
  random: () => number = Math.random
): Result<WideEventSampler, InvalidSamplerRateError> {
  if (!isValidRate(rate)) {
    return Result.err(
      new InvalidSamplerRateError({
        rate,
        message: `Sampler rate must be between 0 and 1. Received: ${rate}`
      })
    );
  }

  return Result.ok(() => {
    const sampled = random() < rate;
    return {
      sampled,
      reason: sampled ? "rate_keep" : "rate_drop",
      rule: `rate:${rate}`
    };
  });
}

export function createRateSampler(
  rate: number,
  random: () => number = Math.random
): WideEventSampler {
  const result = createRateSamplerResult(rate, random);
  if (result.isOk()) {
    return result.value;
  }

  return () => ({
    sampled: false,
    reason: "invalid_sampler_rate",
    rule: `rate:${rate}`
  });
}

export function createNameRateSamplerResult(
  ratesByName: Record<string, number>,
  fallbackRate = 1,
  random: () => number = Math.random
): Result<WideEventSampler, InvalidSamplerRateError> {
  const fallbackResult = createRateSamplerResult(fallbackRate, random);
  if (fallbackResult.isErr()) {
    return fallbackResult;
  }

  for (const rate of Object.values(ratesByName)) {
    if (!isValidRate(rate)) {
      return Result.err(
        new InvalidSamplerRateError({
          rate,
          message: `Sampler rate must be between 0 and 1. Received: ${rate}`
        })
      );
    }
  }

  return Result.ok((event) => {
    const rate = ratesByName[event.name] ?? fallbackRate;
    const sampled = random() < rate;
    return {
      sampled,
      reason: sampled ? "name_rate_keep" : "name_rate_drop",
      rule: `${event.name}:${rate}`
    };
  });
}

export function createNameRateSampler(
  ratesByName: Record<string, number>,
  fallbackRate = 1,
  random: () => number = Math.random
): WideEventSampler {
  const result = createNameRateSamplerResult(ratesByName, fallbackRate, random);
  if (result.isOk()) {
    return result.value;
  }

  return () => ({
    sampled: false,
    reason: "invalid_sampler_rate",
    rule: "name_rate_config"
  });
}

export function composeSamplers(...samplers: WideEventSampler[]): WideEventSampler {
  if (samplers.length === 0) {
    return () => ({ sampled: true, reason: "default_keep" });
  }

  return async (event) => {
    let latestKeepDecision: WideEventSamplingDecision | undefined;

    for (const sampler of samplers) {
      const decision = normalizeSamplingDecision(await sampler(event));

      if (!decision.sampled) {
        return decision;
      }

      latestKeepDecision = decision;
    }

    return latestKeepDecision ?? { sampled: true, reason: "composed_keep" };
  };
}

export function normalizeSamplingDecision(result: WideEventSamplerResult): WideEventSamplingDecision {
  if (typeof result === "boolean") {
    return {
      sampled: result,
      reason: result ? "sampler_keep" : "sampler_drop"
    };
  }

  return {
    sampled: result.sampled,
    reason: result.reason,
    rule: result.rule
  };
}

