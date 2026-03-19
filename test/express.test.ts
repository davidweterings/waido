import { EventEmitter } from "node:events";

import type { NextFunction, Request, Response } from "express";

import {
  __resetWideEventsForTests,
  createExpressWideEventMiddleware,
  flushWideEvents,
  initWaido,
  useLogger,
} from "../src/index.js";
import type { WideEvent } from "../src/index.js";

type MockResponse = Response &
  EventEmitter & {
    statusCode: number;
    writableEnded: boolean;
  };

interface MockRequestOptions {
  path?: string;
  headers?: Record<string, string>;
}

function createMockRequest(options: MockRequestOptions = {}): Request {
  const path = options.path ?? "/users/42";
  const headers: Record<string, string> = {
    "x-request-id": "req-1",
    ...options.headers,
  };

  return {
    method: "GET",
    originalUrl: path,
    url: path,
    headers,
    params: {
      id: "42",
    },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function createMockResponse(statusCode: number): MockResponse {
  const response = new EventEmitter() as MockResponse;
  response.statusCode = statusCode;
  response.writableEnded = false;
  return response;
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function requireLogger() {
  return useLogger();
}

describe("express adapter", () => {
  beforeEach(() => {
    __resetWideEventsForTests();
  });

  it("creates one wide event per request with shared context", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const middleware = createExpressWideEventMiddleware({
      mapData: () => ({
        app: "integration-test",
      }),
    });

    const request = createMockRequest();
    const response = createMockResponse(201);

    await new Promise<void>((resolve, reject) => {
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        Promise.resolve()
          .then(async () => {
            const logger = requireLogger();
            logger.setFields({
              user: {
                id: request.params.id,
              },
            });

            await Promise.resolve();

            requireLogger().setFields({
              operation: "load-user",
            });

            response.writableEnded = true;
            response.emit("finish");
            resolve();
          })
          .catch(reject);
      };

      middleware(request, response, next);
    });

    await waitFor(() => emittedEvents.length === 1);

    expect(emittedEvents[0]).toMatchObject({
      kind: "http",
      outcome: "success",
      status: 201,
      data: {
        app: "integration-test",
        request: {
          id: "req-1",
        },
        user: {
          id: "42",
        },
        operation: "load-user",
      },
    });
    expect((emittedEvents[0].data.request as { method: string }).method).toBe("GET");
  });

  it("supports include/exclude path filters", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const middleware = createExpressWideEventMiddleware({
      includePaths: ["/api/**"],
      excludePaths: ["/api/health"],
    });

    const request = createMockRequest({
      path: "/api/health",
    });
    const response = createMockResponse(200);

    await new Promise<void>((resolve, reject) => {
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        requireLogger().setFields({
          route: "health",
        });

        response.writableEnded = true;
        response.emit("finish");
        resolve();
      };

      middleware(request, response, next);
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emittedEvents).toHaveLength(0);
  });

  it("extracts W3C trace context headers", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const middleware = createExpressWideEventMiddleware();

    const request = createMockRequest({
      headers: {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        tracestate: "acme=1",
      },
    });
    const response = createMockResponse(200);

    await new Promise<void>((resolve, reject) => {
      middleware(request, response, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        response.writableEnded = true;
        response.emit("finish");
        resolve();
      });
    });

    await waitFor(() => emittedEvents.length === 1);
    expect(emittedEvents[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      tracestate: "acme=1",
    });
  });

  it("keeps flushWideEvents pending until an in-flight request finalizes", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const middleware = createExpressWideEventMiddleware();
    const request = createMockRequest();
    const response = createMockResponse(202);

    await new Promise<void>((resolve, reject) => {
      middleware(request, response, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        requireLogger().setFields({
          queue: "payments",
        });
        resolve();
      });
    });

    let flushSettled = false;
    const flushPromise = flushWideEvents({
      timeoutMs: 250,
    }).then((result) => {
      flushSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushSettled).toBe(false);

    response.writableEnded = true;
    response.emit("finish");

    const flushResult = await flushPromise;
    expect(flushResult.isOk()).toBe(true);
    await waitFor(() => emittedEvents.length === 1);
    expect(emittedEvents[0]).toMatchObject({
      status: 202,
      data: {
        queue: "payments",
      },
    });
  });
});
