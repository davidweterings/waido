import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express5 from "express";
import express4 from "express4";
import type { ErrorRequestHandler, Express, Router } from "express";

import { initWaido, useWideEvent, withWideEvent } from "../src/index.js";
import type { WideEvent, WideEventRuntimeConfig } from "../src/index.js";
import {
  createExpressErrorMiddleware,
  createExpressWideEventMiddleware,
  type ExpressErrorMiddlewareOptions,
  type ExpressWideEventOptions,
} from "../src/adapters/express.js";
import { __resetWideEventsForTests } from "#src/runtime.js";

interface ExpressFactory {
  (): Express;
  Router: () => Router;
}

const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);

describe.each([
  ["Express 5", express5 as unknown as ExpressFactory],
  ["Express 4", express4 as unknown as ExpressFactory],
])("%s adapter", (_label, express) => {
  let server: Server | undefined;
  let baseUrl = "";

  async function start(
    routes: (app: Express) => void,
    options: {
      middleware?: ExpressWideEventOptions;
      errors?: ExpressErrorMiddlewareOptions;
      config?: WideEventRuntimeConfig;
    } = {},
  ) {
    const events: WideEvent[] = [];
    const runtime = initWaido({
      drains: [(event) => void events.push(event)],
      ...options.config,
    });

    const app = express();
    app.use(createExpressWideEventMiddleware(options.middleware));
    routes(app);
    app.use(createExpressErrorMiddleware(options.errors));

    const silentErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
      const { status, statusCode } = error as { status?: number; statusCode?: number };
      response.status(status ?? statusCode ?? 500).end();
    };
    app.use(silentErrorHandler);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;

    return { events, flush: () => runtime.flush({ timeoutMs: 1_000 }) };
  }

  beforeEach(() => {
    __resetWideEventsForTests();
  });

  afterEach(async () => {
    await new Promise((resolve) => {
      if (server) {
        server.close(resolve);
        server.closeAllConnections();
      } else {
        resolve(undefined);
      }
    });
    server = undefined;
  });

  it("creates one event per request, shared through context", async () => {
    const { events, flush } = await start(
      (app) => {
        app.get("/users/:id", async (request, response) => {
          useWideEvent().setFields({ user: { id: request.params.id } });
          await Promise.resolve();
          useWideEvent().setFields({ operation: "load-user" });
          response.status(201).json({ ok: true });
        });
      },
      { middleware: { mapData: () => ({ app: "integration-test" }) } },
    );

    await fetch(`${baseUrl}/users/42`, { headers: { "x-request-id": "req-1" } });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "GET /users/:id",
      kind: "http",
      outcome: "success",
      status: 201,
      data: {
        app: "integration-test",
        request: { id: "req-1" },
        user: { id: "42" },
        operation: "load-user",
        http: {
          route: "/users/:id",
          request: { method: "GET" },
          response: { status_code: 201 },
        },
        url: { path: "/users/42" },
      },
    });
  });

  describe("naming and URL capture", () => {
    it("never captures the query string", async () => {
      const { events, flush } = await start((app) => {
        app.get("/search", (_request, response) => {
          response.end();
        });
      });

      await fetch(`${baseUrl}/search?token=SECRET`);
      await flush();

      expect(JSON.stringify(events[0])).not.toContain("SECRET");
      expect(events[0].name).toBe("GET /search");
      expect(events[0].data.url.path).toBe("/search");
    });

    it("includes the mount path of a router", async () => {
      const { events, flush } = await start((app) => {
        const router = express.Router();
        router.get("/users/:id", (_request, response) => {
          response.end();
        });
        app.use("/api", router);
      });

      await fetch(`${baseUrl}/api/users/1`);
      await flush();

      expect(events[0].name).toBe("GET /api/users/:id");
      expect(events[0].data.http.route).toBe("/api/users/:id");
    });

    it("uses only the method when no route matched", async () => {
      const { events, flush } = await start(() => undefined);

      await fetch(`${baseUrl}/nope/12345`);
      await flush();

      expect(events[0]).toMatchObject({ name: "GET", status: 404, outcome: "success" });
      expect(events[0].data.http.route).toBeUndefined();
    });

    it("supports a custom name", async () => {
      const { events, flush } = await start(
        (app) => {
          app.get("/a", (_request, response) => {
            response.end();
          });
        },
        { middleware: { name: (request) => `custom ${request.method}` } },
      );

      await fetch(`${baseUrl}/a`);
      await flush();

      expect(events[0].name).toBe("custom GET");
    });
  });

  describe("outcome", () => {
    it("reports a handled error on a 200 as an error", async () => {
      const { events, flush } = await start((app) => {
        app.get("/handled", (_request, response) => {
          useWideEvent().addError(new Error("card declined"));
          response.status(200).json({ ok: false });
        });
      });

      await fetch(`${baseUrl}/handled`);
      await flush();

      expect(events[0]).toMatchObject({
        outcome: "error",
        status: 200,
        errors: [{ message: "card declined" }],
      });
    });

    it("reports a logged error on a 400 as an error", async () => {
      const { events, flush } = await start((app) => {
        app.get("/client", (_request, response) => {
          useWideEvent().addError(new Error("validation failed"));
          response.status(400).end();
        });
      });

      await fetch(`${baseUrl}/client`);
      await flush();

      expect(events[0]).toMatchObject({ outcome: "error", status: 400 });
    });

    it("captures an exception thrown by a handler", async () => {
      const { events, flush } = await start((app) => {
        app.get("/throws", () => {
          throw new Error("boom");
        });
      });

      await fetch(`${baseUrl}/throws`);
      await flush();

      expect(events[0]).toMatchObject({
        name: "GET /throws",
        outcome: "error",
        status: 500,
        errors: [{ name: "Error", message: "boom" }],
      });
    });

    it("captures an error passed to next from async code", async () => {
      const { events, flush } = await start((app) => {
        app.get("/async", (_request, _response, next) => {
          setTimeout(() => {
            next(new Error("async boom"));
          }, 1);
        });
      });

      await fetch(`${baseUrl}/async`);
      await flush();

      expect(events[0].errors[0].message).toBe("async boom");
    });

    it("doesn't record the same error twice", async () => {
      const { events, flush } = await start((app) => {
        app.get("/both", (_request, _response, next) => {
          const failure = new Error("once");
          useWideEvent().addError(failure);
          next(failure);
        });
      });

      await fetch(`${baseUrl}/both`);
      await flush();

      expect(events[0].errors).toHaveLength(1);
    });

    it("doesn't count a thrown 4xx as a failure", async () => {
      const { events, flush } = await start((app) => {
        app.get("/missing", (_request, _response, next) => {
          next(Object.assign(new Error("not found"), { status: 404 }));
        });
      });

      await fetch(`${baseUrl}/missing`);
      await flush();

      expect(events[0]).toMatchObject({
        outcome: "success",
        status: 404,
        errors: [],
        data: { error: { type: "Error", message: "not found" } },
      });
    });

    it("recognizes statusCode as well as status", async () => {
      const { events, flush } = await start((app) => {
        app.get("/teapot", (_request, _response, next) => {
          next(Object.assign(new Error("teapot"), { statusCode: 418 }));
        });
      });

      await fetch(`${baseUrl}/teapot`);
      await flush();

      expect(events[0].outcome).toBe("success");
    });

    it("counts a thrown 5xx as a failure", async () => {
      const { events, flush } = await start((app) => {
        app.get("/unavailable", (_request, _response, next) => {
          next(Object.assign(new Error("down"), { status: 503 }));
        });
      });

      await fetch(`${baseUrl}/unavailable`);
      await flush();

      expect(events[0]).toMatchObject({ outcome: "error", status: 503 });
      expect(events[0].errors).toHaveLength(1);
    });

    it("lets isFailure override the default", async () => {
      const { events, flush } = await start(
        (app) => {
          app.get("/missing", (_request, _response, next) => {
            next(Object.assign(new Error("not found"), { status: 404 }));
          });
        },
        { errors: { isFailure: () => true } },
      );

      await fetch(`${baseUrl}/missing`);
      await flush();

      expect(events[0].outcome).toBe("error");
    });

    it("reports a request the client abandoned as aborted", async () => {
      let reachedHandler!: () => void;
      const handlerReached = new Promise<void>((resolve) => {
        reachedHandler = resolve;
      });

      const { events, flush } = await start((app) => {
        app.get("/slow", () => {
          reachedHandler();
        });
      });

      const { hostname, port } = new URL(baseUrl);
      const client = httpRequest({ hostname, port, path: "/slow" });
      client.on("error", () => undefined);
      client.end();

      await handlerReached;
      client.destroy();
      await flush();

      expect(events[0]).toMatchObject({ name: "GET /slow", outcome: "aborted" });
      expect(events[0].status).toBeUndefined();
      expect(events[0].data.http.response).toBeUndefined();
    });
  });

  describe("exclusion", () => {
    function healthRoute(app: Express) {
      app.get("/api/health", (_request, response) => {
        useWideEvent().setFields({ route: "health" });
        response.status(500).end();
      });
      app.get("/api/orders", (_request, response) => {
        response.end();
      });
      app.get("/other", (_request, response) => {
        response.end();
      });
    }

    it("captures nothing for excluded paths, even on a 500", async () => {
      const seen: string[] = [];
      const { events, flush } = await start(healthRoute, {
        middleware: { includePaths: ["/api/**"], excludePaths: ["/api/health"] },
        config: { enrichers: [({ event }) => void seen.push(event.name)] },
      });

      await fetch(`${baseUrl}/api/health`);
      await fetch(`${baseUrl}/other`);
      await fetch(`${baseUrl}/api/orders?x=1`);
      await flush();

      expect(events.map((event) => event.name)).toEqual(["GET /api/orders"]);
      expect(seen).toEqual(["GET /api/orders"]);
    });

    it("excludes with a filter function", async () => {
      const { events, flush } = await start(healthRoute, {
        middleware: { filter: (request) => !request.path.endsWith("/health") },
      });

      await fetch(`${baseUrl}/api/health`);
      await flush();

      expect(events).toHaveLength(0);
    });

    it("doesn't let an outer event receive fields from an excluded request", async () => {
      const { events, flush } = await start(healthRoute, {
        middleware: { excludePaths: ["/api/health"] },
      });

      await withWideEvent({ name: "outer" }, () => fetch(`${baseUrl}/api/health`));
      await flush();

      expect(events.map((event) => event.name)).toEqual(["outer"]);
      expect(events[0].data).toEqual({});
    });
  });

  describe("trace context", () => {
    it("treats the header's span as the parent", async () => {
      const { events, flush } = await start((app) => {
        app.get("/a", (_request, response) => {
          response.end();
        });
      });

      await fetch(`${baseUrl}/a`, {
        headers: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, tracestate: "acme=1" },
      });
      await flush();

      expect(events[0]).toMatchObject({
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        traceSampled: true,
      });
      expect(events[0].spanId).toBeUndefined();
      expect(JSON.stringify(events[0])).not.toContain("acme");
    });
  });

  describe("application callbacks", () => {
    it("keeps serving when a callback throws, and reports it", async () => {
      const stages: string[] = [];
      const { events, flush } = await start(
        (app) => {
          app.get("/a", (_request, response) => {
            response.status(200).end();
          });
        },
        {
          config: { onError: (_error, context) => void stages.push(context.stage) },
          middleware: {
            mapData: () => {
              throw new Error("mapData failed");
            },
            name: () => {
              throw new Error("name failed");
            },
          },
        },
      );

      const response = await fetch(`${baseUrl}/a`);
      await flush();

      expect(response.status).toBe(200);
      expect(events[0].name).toBe("GET /a");
      expect(stages).toEqual(["adapter", "adapter"]);
    });
  });

  it("makes flush wait for an in-flight request", async () => {
    let release!: () => void;
    let reachedHandler!: () => void;
    const handlerReached = new Promise<void>((resolve) => {
      reachedHandler = resolve;
    });

    const { events, flush } = await start((app) => {
      app.get("/slow", (_request, response) => {
        useWideEvent().setFields({ queue: "payments" });
        reachedHandler();
        release = () => response.status(202).end();
      });
    });

    const pendingResponse = fetch(`${baseUrl}/slow`);
    await handlerReached;

    let settled = false;
    const flushed = flush().then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await pendingResponse;

    await expect(flushed).resolves.toEqual({ completed: true, pending: 0 });
    expect(events[0]).toMatchObject({ status: 202, data: { queue: "payments" } });
  });

  it("passes requests through untouched when the runtime isn't initialized", async () => {
    const app = express();
    app.use(createExpressWideEventMiddleware());
    app.get("/a", (_request, response) => {
      useWideEvent().set("ignored", true);
      response.status(204).end();
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}/a`);
    expect(response.status).toBe(204);
  });
});
