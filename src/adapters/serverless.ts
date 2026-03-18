import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";

import {
  normalizeAdapterFilterResult,
  resolveIncludeExcludeDecision,
  type EventFilterPattern
} from "#src/filters.js";
import { flushWideEvents, withWideEvent } from "#src/runtime.js";
import { extractTraceContextFromHeaders } from "#src/trace.js";
import type {
  MaybePromise,
  WithWideEventOptions,
  WideEventData,
  WideEventKind,
  WideEventSamplingDecision,
  WideEventTraceContext
} from "#src/types.js";
import { deepMerge } from "#src/utils.js";

function readStringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function firstStringProperty(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const property = readStringProperty(value, key);
    if (property !== undefined) {
      return property;
    }
  }

  return undefined;
}

function toHeaderRecord(
  value: unknown
): Record<string, string | string[] | undefined> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const headers: Record<string, string | string[] | undefined> = {};

  for (const [key, candidateValue] of Object.entries(value)) {
    if (typeof candidateValue === "string") {
      headers[key] = candidateValue;
      continue;
    }

    if (typeof candidateValue === "number" || typeof candidateValue === "boolean") {
      headers[key] = String(candidateValue);
      continue;
    }

    if (Array.isArray(candidateValue)) {
      const values = candidateValue.filter((item): item is string => typeof item === "string");
      if (values.length > 0) {
        headers[key] = values;
      }
    }
  }

  return headers;
}

function inferTraceContextFromMessage(message: unknown): WideEventTraceContext | undefined {
  if (message === null || typeof message !== "object") {
    return undefined;
  }

  const container = message as Record<string, unknown>;
  const headerCandidates = [
    container.headers,
    container.applicationProperties,
    container.properties
  ];

  for (const candidate of headerCandidates) {
    const headers = toHeaderRecord(candidate);
    if (!headers) {
      continue;
    }

    const traceContext = extractTraceContextFromHeaders(headers);
    if (traceContext) {
      return {
        ...traceContext,
        source: traceContext.source ?? "message_headers"
      };
    }
  }

  return undefined;
}

function resolveSamplingDecision(
  name: string,
  include: EventFilterPattern[] | undefined,
  exclude: EventFilterPattern[] | undefined,
  filterResult: boolean | WideEventSamplingDecision | undefined
): WideEventSamplingDecision | undefined {
  return (
    resolveIncludeExcludeDecision(name, {
      include,
      exclude,
      targetName: "function"
    }) ?? normalizeAdapterFilterResult(filterResult, "function")
  );
}

async function withOptionalFlush<T>(
  operation: Promise<BetterResult<T, unknown>>,
  flushAfterCompletion: boolean | undefined
): Promise<BetterResult<T, unknown>> {
  const result = await operation;

  if (flushAfterCompletion ?? true) {
    const flushResult = await flushWideEvents();
    if (flushResult.isErr()) {
      if (result.isErr()) {
        return result;
      }

      return Result.err(flushResult.error);
    }
  }

  return result;
}

export interface MessageWideEventOptions<TMessage, TContext, TResult> {
  name?: string | ((message: TMessage, context: TContext) => string);
  kind?: Extract<WideEventKind, "message" | "function" | "custom">;
  includeNames?: EventFilterPattern[];
  excludeNames?: EventFilterPattern[];
  filter?: (message: TMessage, context: TContext) => boolean | WideEventSamplingDecision;
  data?: WideEventData | ((message: TMessage, context: TContext) => WideEventData);
  traceContext?: (message: TMessage, context: TContext) => WideEventTraceContext | undefined;
  messageId?: (message: TMessage, context: TContext) => string | undefined;
  messageType?: (message: TMessage, context: TContext) => string | undefined;
  statusFromResult?: (
    result: TResult,
    message: TMessage,
    context: TContext
  ) => number | string | undefined;
  flushAfterCompletion?: boolean;
  wideEvent?: WithWideEventOptions;
}

export interface ServerlessWideEventOptions<TArgs extends unknown[], TResult> {
  kind?: Extract<WideEventKind, "function" | "custom" | "message">;
  includeNames?: EventFilterPattern[];
  excludeNames?: EventFilterPattern[];
  filter?: (...args: TArgs) => boolean | WideEventSamplingDecision;
  data?: WideEventData | ((...args: TArgs) => WideEventData);
  traceContext?: (...args: TArgs) => WideEventTraceContext | undefined;
  statusFromResult?: (result: TResult, ...args: TArgs) => number | string | undefined;
  flushAfterCompletion?: boolean;
  wideEvent?: WithWideEventOptions;
}

export function withMessageWideEvent<TMessage, TContext, TResult>(
  handler: (message: TMessage, context: TContext) => MaybePromise<TResult>,
  options: MessageWideEventOptions<TMessage, TContext, TResult> = {}
): (message: TMessage, context: TContext) => Promise<BetterResult<TResult, unknown>> {
  return async (message: TMessage, context: TContext) => {
    const name =
      typeof options.name === "function"
        ? options.name(message, context)
        : options.name ?? "message-handler";

    const messageId =
      options.messageId?.(message, context) ??
      firstStringProperty(message, ["messageId", "id", "lockToken"]);

    const messageType =
      options.messageType?.(message, context) ??
      firstStringProperty(message, ["subject", "type", "label"]);

    const data: WideEventData = {
      message: {
        id: messageId,
        type: messageType
      }
    };

    if (options.data) {
      const customData =
        typeof options.data === "function" ? options.data(message, context) : options.data;
      deepMerge(data, customData);
    }

    const samplingDecision = resolveSamplingDecision(
      name,
      options.includeNames,
      options.excludeNames,
      options.filter?.(message, context)
    );

    const traceContext =
      options.traceContext?.(message, context) ?? inferTraceContextFromMessage(message);

    return withOptionalFlush(
      withWideEvent(
        {
          name,
          kind: options.kind ?? "message",
          data,
          traceContext,
          samplingDecision
        },
        async (logger) => {
          const result = await handler(message, context);
          const status = options.statusFromResult?.(result, message, context);
          if (status !== undefined) {
            logger.setStatus(status);
          }
          return result;
        },
        options.wideEvent
      ),
      options.flushAfterCompletion
    );
  };
}

export function withServerlessWideEvent<TArgs extends unknown[], TResult>(
  name: string,
  handler: (...args: TArgs) => MaybePromise<TResult>,
  options: ServerlessWideEventOptions<TArgs, TResult> = {}
): (...args: TArgs) => Promise<BetterResult<TResult, unknown>> {
  return async (...args: TArgs) => {
    const samplingDecision = resolveSamplingDecision(
      name,
      options.includeNames,
      options.excludeNames,
      options.filter?.(...args)
    );

    return withOptionalFlush(
      withWideEvent(
        {
          name,
          kind: options.kind ?? "function",
          data: typeof options.data === "function" ? options.data(...args) : options.data,
          traceContext: options.traceContext?.(...args),
          samplingDecision
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
      ),
      options.flushAfterCompletion
    );
  };
}
