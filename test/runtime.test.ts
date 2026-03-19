import {
  __resetWideEventsForTests,
  createStructuredError,
  createWideEventLogger,
  flushWideEvents,
  initWaido,
  runWithLoggerContext,
  useLogger,
  withWideContext,
} from "../src/index.js";
import type { WideEvent } from "../src/index.js";

function requireLogger() {
  return useLogger();
}

describe("runtime", () => {
  beforeEach(() => {
    __resetWideEventsForTests();
  });

  it("stores and retrieves the logger from AsyncLocalStorage", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      service: "test-service",
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "unit-job",
        kind: "function",
      },
      async () => {
        const logger = requireLogger();
        logger.setFields({
          user: { id: "user_123" },
        });

        await Promise.resolve();

        requireLogger().setFields({
          step: "done",
        });
      },
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      service: "test-service",
      name: "unit-job",
      kind: "function",
      outcome: "success",
      sampled: true,
      data: {
        user: { id: "user_123" },
        step: "done",
      },
    });
  });

  it("runs enrich hooks before drains", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      enrichers: [
        ({ event }) => {
          event.data.enriched = true;
        },
      ],
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "enrich-test",
      },
      async (logger) => {
        logger.setFields({
          input: true,
        });
      },
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].data).toMatchObject({
      input: true,
      enriched: true,
    });
  });

  it("exposes sampling reason and rule on dropped events", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      sampler: () => ({
        sampled: false,
        reason: "healthcheck_noise",
        rule: "name=health-check",
      }),
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "health-check",
      },
      async () => undefined,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeUndefined();
    }
    expect(emittedEvents).toHaveLength(0);
  });

  it("returns sampling diagnostics from logger.emit", async () => {
    initWaido({
      sampler: () => ({
        sampled: false,
        reason: "sampled_out",
        rule: "rate:0",
      }),
    });

    const logger = createWideEventLogger({
      name: "drop-me",
    });

    const event = await runWithLoggerContext(logger, async () => logger.emit());
    expect(event.sampled).toBe(false);
    expect(event.sampling).toMatchObject({
      sampled: false,
      reason: "sampled_out",
      rule: "rate:0",
    });
  });

  it("adds structured error why/fix/link fields", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "checkout",
      },
      async () => {
        throw createStructuredError({
          message: "Payment failed",
          why: "Card declined by issuer",
          fix: "Use another card or retry in 10 minutes",
          link: "https://docs.example.com/payments",
          code: "PAYMENT_DECLINED",
        });
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect((result.error as Error).message).toBe("Payment failed");
    }

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].errors[0]).toMatchObject({
      message: "Payment failed",
      why: "Card declined by issuer",
      fix: "Use another card or retry in 10 minutes",
      link: "https://docs.example.com/payments",
      code: "PAYMENT_DECLINED",
    });
  });

  it("truncates oversized payloads when payload policy is truncate", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      payloadPolicy: {
        maxBytes: 450,
        overflowStrategy: "truncate",
      },
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "oversized",
        data: {
          huge: "x".repeat(1000),
          keep: "ok",
        },
      },
      async () => undefined,
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].payload).toMatchObject({
      limited: true,
      strategy: "truncate",
    });
    expect(Buffer.byteLength(JSON.stringify(emittedEvents[0]), "utf8")).toBeLessThanOrEqual(450);
  });

  it("drops oversized payloads when payload policy is drop", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      payloadPolicy: {
        maxBytes: 300,
        overflowStrategy: "drop",
      },
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const logger = createWideEventLogger({
      name: "too-big",
      data: {
        huge: "y".repeat(2000),
      },
    });

    const event = await runWithLoggerContext(logger, async () => logger.emit());
    expect(event.sampled).toBe(false);
    expect(event.sampling.reason).toBe("payload_dropped");
    expect(emittedEvents).toHaveLength(0);
  });

  it("extracts trace context from runtime extractor", async () => {
    const emittedEvents: WideEvent[] = [];
    initWaido({
      traceContextExtractor: () => ({
        traceId: "trace-1",
        spanId: "span-1",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        source: "test",
      }),
      drains: [
        async (event) => {
          emittedEvents.push(event);
        },
      ],
    });

    const result = await withWideContext(
      {
        name: "trace-test",
      },
      async () => undefined,
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents[0]).toMatchObject({
      traceId: "trace-1",
      spanId: "span-1",
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      traceSource: "test",
    });
  });

  it("flushes pending wide event emits", async () => {
    const drainedNames: string[] = [];
    initWaido({
      drains: [
        async (event) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          drainedNames.push(event.name);
        },
      ],
    });

    const logger = createWideEventLogger({
      name: "async-flush",
    });

    runWithLoggerContext(logger, () => {
      void logger.emit();
    });

    const flushResult = await flushWideEvents();
    expect(flushResult.isOk()).toBe(true);
    expect(drainedNames).toEqual(["async-flush"]);
  });

  it("returns noop logger outside context", () => {
    const log = useLogger();
    log.setFields({ ignored: true });
    log.increment("counter");
    log.append("list", "item");
    log.error(new Error("ignored"));
    expect(log.hasEmitted()).toBe(false);
  });

  it("returns err from withWideContext when work throws", async () => {
    const result = await withWideContext(
      {
        name: "result-fail",
      },
      async () => {
        throw new Error("boom");
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect((result.error as Error).message).toBe("boom");
    }
  });

  it("returns err from flushWideEvents on timeout", async () => {
    initWaido({
      drains: [
        async () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          }),
      ],
    });

    const logger = createWideEventLogger({
      name: "slow-drain",
    });

    runWithLoggerContext(logger, () => {
      void logger.emit();
    });

    const result = await flushWideEvents({
      timeoutMs: 10,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("FlushWideEventsTimeoutError");
    }

    await flushWideEvents();
  });
});
