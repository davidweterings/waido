import type { Request, RequestHandler } from "express";

import { createWideEventLogger, runWithLoggerContext } from "#src/runtime.js";
import {
  normalizeAdapterFilterResult,
  resolveIncludeExcludeDecision,
  type EventFilterPattern,
  normalizePath,
} from "#src/filters.js";
import { extractTraceContextFromHeaders } from "#src/trace.js";
import type {
  WideEventData,
  WideEventKind,
  WideEventOutcome,
  WideEventSamplingDecision,
} from "#src/types.js";
import { deepMerge } from "#src/utils.js";

export interface ExpressWideEventOptions {
  name?: string | ((request: Request) => string);
  kind?: WideEventKind;
  requestIdHeader?: string;
  includePaths?: EventFilterPattern[];
  excludePaths?: EventFilterPattern[];
  filter?: (request: Request) => boolean | WideEventSamplingDecision;
  mapData?: (request: Request) => WideEventData;
}

function resolveName(request: Request, value: ExpressWideEventOptions["name"]): string {
  if (typeof value === "function") {
    return value(request);
  }

  if (typeof value === "string") {
    return value;
  }

  const path = request.originalUrl || request.url;
  return `${request.method} ${path}`;
}

function resolvePath(request: Request): string {
  return normalizePath(request.originalUrl || request.url);
}

function resolveSamplingDecision(
  request: Request,
  options: ExpressWideEventOptions,
): WideEventSamplingDecision | undefined {
  const path = resolvePath(request);
  return (
    resolveIncludeExcludeDecision(path, {
      include: options.includePaths,
      exclude: options.excludePaths,
      targetName: "route",
    }) ?? normalizeAdapterFilterResult(options.filter?.(request), "route")
  );
}

function resolveRequestData(request: Request, options: ExpressWideEventOptions): WideEventData {
  const requestData: WideEventData = {
    request: {
      method: request.method,
      path: request.originalUrl || request.url,
    },
  };

  const requestIdHeader = options.requestIdHeader ?? "x-request-id";
  const requestId = request.header(requestIdHeader);
  if (requestId) {
    (requestData.request as Record<string, unknown>).id = requestId;
  }

  if (options.mapData) {
    deepMerge(requestData, options.mapData(request));
  }

  return requestData;
}

export function createExpressWideEventMiddleware(
  options: ExpressWideEventOptions = {},
): RequestHandler {
  return (request, response, next) => {
    const traceContext = extractTraceContextFromHeaders(
      (request.headers ?? {}) as Record<string, string | string[] | undefined>,
    );

    const logger = createWideEventLogger({
      name: resolveName(request, options.name),
      kind: options.kind ?? "http",
      data: resolveRequestData(request, options),
      traceContext,
      samplingDecision: resolveSamplingDecision(request, options),
    });

    let finalized = false;

    const finalize = (outcome: WideEventOutcome, error?: unknown): void => {
      if (finalized) {
        return;
      }

      finalized = true;

      if (error !== undefined) {
        logger.error(error);
      }

      void logger.emit({
        outcome,
        status: response.statusCode,
        data: {
          response: {
            statusCode: response.statusCode,
          },
        },
      });
    };

    response.once("finish", () => {
      const outcome = response.statusCode >= 500 ? "error" : "success";
      finalize(outcome);
    });

    response.once("close", () => {
      if (!response.writableEnded) {
        finalize("aborted");
      }
    });

    response.once("error", (error) => {
      finalize("error", error);
    });

    runWithLoggerContext(logger, () => next());
  };
}
