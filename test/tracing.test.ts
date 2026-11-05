import { SpanStatusCode, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { createRedactor, createWideEvent, initWaido, withWideEvent } from "../src/index.js";
import type { WideEvent, WideEventRuntimeConfig } from "../src/index.js";
import { __resetWideEventsForTests } from "#src/runtime.js";
import { __setTracingApiForTests, runWithoutTracing } from "#src/tracing.js";

describe("automatic tracing support", () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  beforeAll(() => {
    tracerProvider.register();
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
  });

  beforeEach(() => {
    __resetWideEventsForTests();
    __setTracingApiForTests(undefined);
    spanExporter.reset();
  });

  afterEach(() => {
    __setTracingApiForTests(undefined);
  });

  function setup(config: WideEventRuntimeConfig = {}) {
    const events: WideEvent[] = [];
    const runtime = initWaido({ drains: [(event) => void events.push(event)], ...config });
    return { events, runtime };
  }

  async function inSpan(work: () => Promise<unknown>): Promise<void> {
    await trace.getTracer("test").startActiveSpan("server", async (span) => {
      await work();
      span.end();
    });
  }

  describe("without tracing", () => {
    it("works when the app doesn't have the OpenTelemetry API", async () => {
      __setTracingApiForTests(null);
      const { events, runtime } = setup();

      await inSpan(() => withWideEvent({ name: "job", data: { field: 1 } }, () => undefined));
      await runtime.flush();

      expect(events[0].traceId).toBeUndefined();
      expect(spanExporter.getFinishedSpans()[0].attributes).not.toHaveProperty("field");
      expect(runWithoutTracing(() => "ran")).toBe("ran");
    });

    it("leaves trace fields empty when no span is active", async () => {
      const { events, runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].traceId).toBeUndefined();
    });
  });

  describe("trace identity", () => {
    it("takes trace and span IDs from the active span, with no configuration", async () => {
      const { events, runtime } = setup();
      let traceId = "";
      let spanId = "";

      await inSpan(async () => {
        const context = trace.getActiveSpan()?.spanContext();
        traceId = context?.traceId ?? "";
        spanId = context?.spanId ?? "";
        await withWideEvent({ name: "job" }, () => undefined);
      });
      await runtime.flush();

      expect(events[0]).toMatchObject({ traceId, spanId, traceSampled: true });
    });

    it("prefers the active span over a header naming another trace", async () => {
      const { events, runtime } = setup();
      let traceId = "";

      await inSpan(async () => {
        traceId = trace.getActiveSpan()?.spanContext().traceId ?? "";
        await withWideEvent(
          {
            name: "job",
            traceContext: { traceId: "a".repeat(32), parentSpanId: "b".repeat(16) },
          },
          () => undefined,
        );
      });
      await runtime.flush();

      expect(events[0].traceId).toBe(traceId);
      expect(events[0].parentSpanId).toBeUndefined();
    });

    it("still takes IDs when span enrichment is off", async () => {
      const { events, runtime } = setup({ enrichSpans: false });

      await inSpan(() => withWideEvent({ name: "job", data: { field: 1 } }, () => undefined));
      await runtime.flush();

      expect(events[0].traceId).toBeDefined();
      expect(spanExporter.getFinishedSpans()[0].attributes).not.toHaveProperty("field");
    });
  });

  describe("span enrichment", () => {
    it("flattens fields onto the active span", async () => {
      const { runtime } = setup();

      await inSpan(() =>
        withWideEvent({ name: "job", kind: "queue" }, (event) => {
          event.setFields({
            user: { id: "u1", tier: "pro" },
            count: 3,
            flag: true,
            tags: ["a", "b"],
            mixed: [1, "two"],
            items: [{ sku: "x" }],
            nothing: null,
          });
        }),
      );
      await runtime.flush();

      expect(spanExporter.getFinishedSpans()[0].attributes).toMatchObject({
        "user.id": "u1",
        "user.tier": "pro",
        count: 3,
        flag: true,
        tags: ["a", "b"],
        mixed: '[1,"two"]',
        items: '[{"sku":"x"}]',
        "waido.outcome": "success",
        "waido.event.name": "job",
        "waido.event.kind": "queue",
        "waido.duration_ms": expect.any(Number),
        "waido.event.id": expect.any(String),
      });
      expect(spanExporter.getFinishedSpans()[0].attributes).not.toHaveProperty("nothing");
    });

    it("writes to the span even when the event is sampled out", async () => {
      const { events, runtime } = setup({ sampler: () => false });

      await inSpan(() =>
        withWideEvent({ name: "job" }, (event) => {
          event.set("kept", "on span");
        }),
      );
      await runtime.flush();

      expect(events).toHaveLength(0);
      expect(spanExporter.getFinishedSpans()[0].attributes.kept).toBe("on span");
    });

    it("doesn't put the sample rate on spans", async () => {
      const { runtime } = setup();

      await inSpan(() => withWideEvent({ name: "job" }, () => undefined));
      await runtime.flush();

      expect(spanExporter.getFinishedSpans()[0].attributes).not.toHaveProperty("waido.sample_rate");
    });

    it("applies redaction before writing to the span", async () => {
      const { runtime } = setup({ redact: createRedactor({ paths: ["user.email"] }) });

      await inSpan(() =>
        withWideEvent({ name: "job", data: { user: { email: "a@b.c" } } }, () => undefined),
      );
      await runtime.flush();

      expect(spanExporter.getFinishedSpans()[0].attributes["user.email"]).toBe("[REDACTED]");
    });

    it("records every error and sets the span status", async () => {
      const { runtime } = setup();

      await inSpan(() =>
        withWideEvent({ name: "job" }, (event) => {
          event.addError(new TypeError("first"));
          event.addError(new RangeError("second"));
        }),
      );
      await runtime.flush();

      const [span] = spanExporter.getFinishedSpans();
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "first" });
      expect(span.events.map((event) => event.name)).toEqual(["exception", "exception"]);
      expect(span.attributes).toMatchObject({ "error.type": "TypeError", "waido.error_count": 2 });
    });

    it("leaves the span status alone when the outcome overrides the error", async () => {
      const { runtime } = setup();

      await inSpan(() =>
        withWideEvent({ name: "job" }, (event) => {
          event.addError(new Error("recovered"));
          event.setOutcome("success");
        }),
      );
      await runtime.flush();

      expect(spanExporter.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.UNSET);
    });

    it("skips a span that has already ended, without failing", async () => {
      const failures: unknown[] = [];
      const { events, runtime } = setup({ onError: (error) => void failures.push(error) });

      await inSpan(async () => {
        const span = trace.getActiveSpan();
        await withWideEvent({ name: "job" }, () => {
          span?.end();
        });
      });
      await runtime.flush();

      expect(events).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    it("lets only the first event on a span write to it", async () => {
      const { events, runtime } = setup();

      await inSpan(() =>
        withWideEvent({ name: "parent", data: { owner: "parent" } }, async () => {
          await withWideEvent({ name: "child", data: { owner: "child", extra: 1 } }, (event) => {
            event.addError(new Error("handled in the child"));
          });
        }),
      );
      await runtime.flush();

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes).toMatchObject({ owner: "parent", "waido.outcome": "success" });
      expect(span.attributes).not.toHaveProperty("extra");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.events).toHaveLength(0);

      // The child is still kept in full, and shares the span's identity.
      expect(events.map((event) => event.name)).toEqual(["child", "parent"]);
      expect(events[0].spanId).toBe(span.spanContext().spanId);
      expect(events[0].data.extra).toBe(1);
    });

    it("moves to the active span when the one it started on has ended", async () => {
      const { events, runtime } = setup();
      const tracer = trace.getTracer("test");
      let serverSpanId = "";

      await tracer.startActiveSpan("server", async (server) => {
        serverSpanId = server.spanContext().spanId;

        const event = tracer.startActiveSpan("middleware", (middleware) => {
          middleware.end();
          return createWideEvent({ name: "job", data: { field: 1 } });
        });

        event.emit();
        server.end();
      });
      await runtime.flush();

      const server = spanExporter.getFinishedSpans().find((span) => span.name === "server");
      expect(server?.attributes.field).toBe(1);
      expect(events[0].spanId).toBe(serverSpanId);
    });

    it("keeps the event when a span is unsampled", async () => {
      const { events, runtime } = setup();
      const unsampled = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: TraceFlags.NONE,
      });

      await trace.getTracer("test").startActiveSpan("unsampled", {}, unsampled, async (span) => {
        await withWideEvent({ name: "job", data: { field: 1 } }, () => undefined);
        span.end();
      });
      await runtime.flush();

      expect(events[0]).toMatchObject({ traceId: "a".repeat(32), data: { field: 1 } });
    });
  });

  describe("waido's own network calls", () => {
    it("runs them outside the active trace, with tracing suppressed", async () => {
      await inSpan(async () => {
        expect(trace.getActiveSpan()).toBeDefined();

        runWithoutTracing(() => {
          expect(trace.getActiveSpan()).toBeUndefined();
          const span = trace.getTracer("test").startSpan("should-not-record");
          expect(span.isRecording()).toBe(false);
          span.end();
        });
      });
    });
  });
});
