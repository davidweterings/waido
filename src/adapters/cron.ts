import {
  normalizeAdapterFilterResult,
  resolveIncludeExcludeDecision,
  type EventFilterPattern
} from "#src/filters.js";
import { withWideEvent } from "#src/runtime.js";
import type {
  MaybePromise,
  WithWideEventOptions,
  WideEventData,
  WideEventKind,
  WideEventSamplingDecision,
  WideEventTraceContext
} from "#src/types.js";
import type { Result as BetterResult } from "better-result";

export interface CronWideEventOptions<TArgs extends unknown[], TResult> {
  name?: string | ((...args: TArgs) => string);
  kind?: Extract<WideEventKind, "cron" | "function" | "custom">;
  includeNames?: EventFilterPattern[];
  excludeNames?: EventFilterPattern[];
  filter?: (...args: TArgs) => boolean | WideEventSamplingDecision;
  data?: WideEventData | ((...args: TArgs) => WideEventData);
  traceContext?: (...args: TArgs) => WideEventTraceContext | undefined;
  statusFromResult?: (result: TResult, ...args: TArgs) => number | string | undefined;
  wideEvent?: WithWideEventOptions;
}

function resolveName<TArgs extends unknown[]>(
  defaultName: string,
  args: TArgs,
  override?: string | ((...args: TArgs) => string)
): string {
  if (typeof override === "function") {
    return override(...args);
  }

  return override ?? defaultName;
}

function resolveData<TArgs extends unknown[]>(
  args: TArgs,
  data?: WideEventData | ((...args: TArgs) => WideEventData)
): WideEventData | undefined {
  if (typeof data === "function") {
    return data(...args);
  }

  return data;
}

function resolveSamplingDecision<TArgs extends unknown[], TResult>(
  name: string,
  args: TArgs,
  options: CronWideEventOptions<TArgs, TResult>
): WideEventSamplingDecision | undefined {
  return (
    resolveIncludeExcludeDecision(name, {
      include: options.includeNames,
      exclude: options.excludeNames,
      targetName: "function"
    }) ?? normalizeAdapterFilterResult(options.filter?.(...args), "function")
  );
}

export function withCronWideEvent<TArgs extends unknown[], TResult>(
  name: string,
  handler: (...args: TArgs) => MaybePromise<TResult>,
  options: CronWideEventOptions<TArgs, TResult> = {}
): (...args: TArgs) => Promise<BetterResult<TResult, unknown>> {
  return async (...args: TArgs) => {
    const resolvedName = resolveName(name, args, options.name);

    return withWideEvent(
      {
        name: resolvedName,
        kind: options.kind ?? "cron",
        data: resolveData(args, options.data),
        traceContext: options.traceContext?.(...args),
        samplingDecision: resolveSamplingDecision(resolvedName, args, options)
      },
      async (logger) => {
        const result = await handler(...args);
        const status = options.statusFromResult?.(result, ...args);
        if (status !== undefined) {
          logger.setStatus(status);
        }
        return result;
      },
      options.wideEvent
    );
  };
}

export function runCronWideEvent<TResult>(
  name: string,
  handler: () => MaybePromise<TResult>,
  options: Omit<CronWideEventOptions<[], TResult>, "name"> = {}
): Promise<BetterResult<TResult, unknown>> {
  return withCronWideEvent(name, handler, options)();
}
