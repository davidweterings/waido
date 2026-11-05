import { logs, ROOT_CONTEXT, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  createRedactor,
  createTailSampler,
  createWideEvent,
  errors,
  initWaido,
  withWideEvent,
} from "../src/index.js";
import type { WideEvent, WideEventRuntimeConfig } from "../src/index.js";
import { otel, type OtelOptions } from "../src/otel.js";
import { __resetWideEventsForTests } from "#src/runtime.js";

describe("waido/otel", () => {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });

  beforeAll(() => {
    tracerProvider.register();
    logs.setGlobalLoggerProvider(loggerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
    await loggerProvider.shutdown();
    trace.disable();
    logs.disable();
  });

  beforeEach(() => {
    __resetWideEventsForTests();
    spanExporter.reset();
    logExporter.reset();
  });

  function setup(options?: OtelOptions, config: WideEventRuntimeConfig = {}) {
    const events: WideEvent[] = [];
    const runtime = initWaido({
      drains: [(event) => void events.push(event)],
      integrations: [otel(options)],
      ...config,
    });
    return { events, runtime };
  }

  async function inSpan(work: () => Promise<unknown>): Promise<void> {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("server", async (span) => {
      await work();
      span.end();
    });
  }

  describe("trace identity", () => {
    it("takes trace and span IDs from the active span", async () => {
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

    it("leaves trace fields empty with no active span", async () => {
      const { events, runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].traceId).toBeUndefined();
    });
  });

  describe("span mirror", () => {
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
      const { events, runtime } = setup(undefined, { sampler: () => false });

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
      const { runtime } = setup(undefined, { redact: createRedactor({ paths: ["user.email"] }) });

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
      const { events, runtime } = setup(undefined, {
        onError: (error) => void failures.push(error),
      });

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

      // The child is still exported in full, and shares the span's identity.
      expect(events.map((event) => event.name)).toEqual(["child", "parent"]);
      expect(events[0].spanId).toBe(span.spanContext().spanId);
      expect(logExporter.getFinishedLogRecords()[0].attributes.extra).toBe(1);
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

    it("can be turned off", async () => {
      const { runtime } = setup({ spans: false });

      await inSpan(() => withWideEvent({ name: "job", data: { field: 1 } }, () => undefined));
      await runtime.flush();

      expect(spanExporter.getFinishedSpans()[0].attributes).not.toHaveProperty("field");
    });
  });

  describe("log records", () => {
    it("emits kept events with their fields, severity and trace", async () => {
      const { runtime } = setup();
      let traceId = "";
      let spanId = "";

      await inSpan(async () => {
        const context = trace.getActiveSpan()?.spanContext();
        traceId = context?.traceId ?? "";
        spanId = context?.spanId ?? "";
        await withWideEvent({ name: "checkout" }, (event) => {
          event.setFields({ user: { id: "u1" } });
        });
      });
      await runtime.flush();

      const [record] = logExporter.getFinishedLogRecords();
      expect(record.eventName).toBe("waido.wide_event");
      expect(record.body).toBe("checkout");
      expect(record.severityText).toBe("INFO");
      expect(record.spanContext).toMatchObject({ traceId, spanId });
      expect(record.attributes).toMatchObject({
        "user.id": "u1",
        "waido.outcome": "success",
        "waido.sample_rate": 1,
        "waido.sampling.reason": "default_keep",
      });
    });

    it("emits nothing for dropped events", async () => {
      const { runtime } = setup(undefined, { sampler: () => false });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    });

    it("is unaffected by an unsampled span", async () => {
      const { runtime } = setup();
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

      const [record] = logExporter.getFinishedLogRecords();
      expect(record.attributes.field).toBe(1);
      expect(record.spanContext?.traceId).toBe("a".repeat(32));
    });

    it("carries the tail sampler's rate and rule", async () => {
      const { runtime } = setup(undefined, {
        sampler: createTailSampler({ keep: [errors()], rate: 0.05, random: () => 0 }),
      });

      await withWideEvent({ name: "kept-by-rate" }, () => undefined);
      await withWideEvent({ name: "kept-by-rule" }, (event) => {
        event.addError(new Error("boom"));
      });
      await runtime.flush();

      const [byRate, byRule] = logExporter.getFinishedLogRecords();
      expect(byRate.attributes["waido.sample_rate"]).toBe(20);
      expect(byRule.attributes).toMatchObject({
        "waido.sample_rate": 1,
        "waido.sampling.rule": "errors",
      });
    });

    it("maps the first error to exception attributes", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, (event) => {
        event.addError(new TypeError("first"));
        event.addError(new RangeError("second"));
      });
      await runtime.flush();

      const [record] = logExporter.getFinishedLogRecords();
      expect(record.severityText).toBe("ERROR");
      expect(record.attributes).toMatchObject({
        "error.type": "TypeError",
        "exception.type": "TypeError",
        "exception.message": "first",
        "exception.stacktrace": expect.stringContaining("TypeError: first"),
        "waido.error_count": 2,
      });
    });

    it("counts dropped errors in the error count", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, (event) => {
        for (let index = 0; index < 12; index += 1) {
          event.addError(new Error(`failure ${index}`));
        }
      });
      await runtime.flush();

      expect(logExporter.getFinishedLogRecords()[0].attributes["waido.error_count"]).toBe(12);
    });

    it("uses the parent span from a header when there is no active span", async () => {
      const { runtime } = setup();

      await withWideEvent(
        {
          name: "job",
          traceContext: {
            traceId: "a".repeat(32),
            parentSpanId: "b".repeat(16),
            traceSampled: true,
          },
        },
        () => undefined,
      );
      await runtime.flush();

      expect(logExporter.getFinishedLogRecords()[0].spanContext).toMatchObject({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
      });
    });

    it("supports a custom sample rate attribute", async () => {
      const { runtime } = setup({ sampleRateAttribute: "SampleRate" });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      const [record] = logExporter.getFinishedLogRecords();
      expect(record.attributes.SampleRate).toBe(1);
      expect(record.attributes).not.toHaveProperty("waido.sample_rate");
    });

    it("can be turned off", async () => {
      const { runtime } = setup({ logs: false });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    });
  });
});
