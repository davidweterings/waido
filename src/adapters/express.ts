import { errorMonitor } from "node:events";

import type { ErrorRequestHandler, Request, RequestHandler } from "express";

import { createPathMatcher, normalizePath, type EventFilterPattern } from "#src/filters.js";
import { noopLogger, type WideEventLogger } from "#src/logger.js";
import {
  createWideEventLogger,
  reportAdapterError,
  runWithLoggerContext,
  startWideEventScope,
  useLogger,
} from "#src/runtime.js";
import { extractTraceContextFromHeaders } from "#src/trace.js";
import type { WideEventData, WideEventKind } from "#src/types.js";
import { deepMerge } from "#src/utils.js";

export interface ExpressWideEventOptions {
  /** Overrides the default name of `<METHOD> <route>`. A function runs when the response ends. */
  name?: string | ((request: Request) => string);
  kind?: WideEventKind;
  requestIdHeader?: string;
  includePaths?: EventFilterPattern[];
  excludePaths?: EventFilterPattern[];
  /** Return `false` to skip capturing this request. */
  filter?: (request: Request) => boolean;
  /** Adds fields when the request starts. Query strings are only captured if you add them here. */
  mapData?: (request: Request) => WideEventData;
}

export interface ExpressErrorMiddlewareOptions {
  /**
   * Whether a thrown error counts as a failure. Defaults to true unless the error has a
   * `status` or `statusCode` below 500. Others are stored in `data.error` and leave the outcome alone.
   */
  isFailure?: (error: unknown, request: Request) => boolean;
}

const loggersByRequest = new WeakMap<Request, WideEventLogger>();

/** Calls an application callback. Its failure must not break the request being observed. */
function guarded<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch (error) {
    reportAdapterError(error);
    return undefined;
  }
}

function resolveRoute(request: Request): string | undefined {
  const route: unknown = request.route?.path;
  return route === undefined ? undefined : `${request.baseUrl ?? ""}${String(route)}`;
}

function resolveName(request: Request, option: ExpressWideEventOptions["name"]): string {
  const custom = typeof option === "function" ? guarded(() => option(request)) : option;
  if (custom !== undefined) {
    return custom;
  }

  const route = resolveRoute(request);
  return route === undefined ? request.method : `${request.method} ${route}`;
}

function resolveRequestData(request: Request, options: ExpressWideEventOptions): WideEventData {
  const data: WideEventData = {
    http: { request: { method: request.method } },
    url: { path: normalizePath(request.originalUrl || request.url) },
  };

  const requestId = request.header(options.requestIdHeader ?? "x-request-id");
  if (requestId) {
    data.request = { id: requestId };
  }

  const mapped = options.mapData && guarded(() => options.mapData?.(request));
  return mapped ? deepMerge(data, mapped) : data;
}

/**
 * Captures one wide event per request and emits it when the response ends. Mount it before your
 * routes, and mount `createExpressErrorMiddleware()` after them.
 */
export function createExpressWideEventMiddleware(
  options: ExpressWideEventOptions = {},
): RequestHandler {
  const matchesPath = createPathMatcher({
    include: options.includePaths,
    exclude: options.excludePaths,
  });

  return (request, response, next) => {
    const path = normalizePath(request.originalUrl || request.url);
    const captured =
      matchesPath(path) && (options.filter ? guarded(() => options.filter?.(request)) : true);

    if (captured === false) {
      runWithLoggerContext(noopLogger, next);
      return;
    }

    const logger = createWideEventLogger({
      name: typeof options.name === "string" ? options.name : request.method,
      kind: options.kind ?? "http",
      data: resolveRequestData(request, options),
      traceContext: extractTraceContextFromHeaders(request.headers),
    });
    loggersByRequest.set(request, logger);

    const closeScope = startWideEventScope();

    const finalize = (input: { aborted?: boolean; error?: unknown }): void => {
      if (logger.hasEmitted()) {
        closeScope();
        return;
      }

      if (input.error !== undefined) {
        logger.error(input.error);
      }

      const hasResponded = response.headersSent;
      logger.emit({
        name: resolveName(request, options.name),
        aborted: input.aborted,
        status: hasResponded ? response.statusCode : undefined,
        data: {
          http: {
            route: resolveRoute(request),
            response: hasResponded ? { status_code: response.statusCode } : undefined,
          },
        },
      });
      closeScope();
    };

    // `finish` fires before `close`, so the active span can still receive the fields.
    response.once("finish", () => {
      finalize({});
    });
    response.once("close", () => {
      if (!response.writableFinished) {
        finalize({ aborted: true });
      }
    });
    // `errorMonitor` observes the error without counting as a handler, which would swallow it.
    response.once(errorMonitor, (error: unknown) => {
      finalize({ error });
    });

    runWithLoggerContext(logger, next);
  };
}

function hasClientStatus(error: unknown): boolean {
  const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = status ?? statusCode;
  return typeof code === "number" && code < 500;
}

function describeError(error: unknown): { type: string; message: string } {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { type: "NonErrorThrown", message: String(error) };
}

/**
 * Records errors passed to Express, then forwards them to your error handlers. Express doesn't let
 * other middleware see them, so mount this after your routes.
 */
export function createExpressErrorMiddleware(
  options: ExpressErrorMiddlewareOptions = {},
): ErrorRequestHandler {
  return (error, request, _response, next) => {
    const logger = loggersByRequest.get(request) ?? useLogger();
    const isFailure = options.isFailure
      ? (guarded(() => options.isFailure?.(error, request)) ?? true)
      : !hasClientStatus(error);

    if (isFailure) {
      logger.error(error);
    } else {
      logger.setFields({ error: describeError(error) });
    }

    next(error);
  };
}
