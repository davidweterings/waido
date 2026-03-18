import {
  __resetWideEventsForTests,
  createWideEventLogger,
  initWideEvents,
  runWithLoggerContext,
  useLogger,
  withCronWideEvent,
  withMessageWideEvent,
  withServerlessWideEvent
} from "../src/index.js";
import type { WideEvent } from "../src/index.js";

function requireLogger() {
  const loggerResult = useLogger();
  if (loggerResult.isErr()) {
    throw loggerResult.error;
  }

  return loggerResult.value;
}

describe("cron and serverless adapters", () => {
  beforeEach(() => {
    __resetWideEventsForTests();
  });

  it("wraps cron handlers in a wide event context", async () => {
    const emittedEvents: WideEvent[] = [];
    initWideEvents({
      drains: [async (event) => {
        emittedEvents.push(event);
      }]
    });

    const job = withCronWideEvent(
      "nightly-sync",
      async () => {
        requireLogger().set({
          recordsSynced: 120
        });
        return {
          ok: true
        };
      },
      {
        statusFromResult: (result) => (result.ok ? "ok" : "failed")
      }
    );

    const result = await job();
    expect(result.isOk()).toBe(true);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      name: "nightly-sync",
      kind: "cron",
      status: "ok",
      data: {
        recordsSynced: 120
      }
    });
  });

  it("supports include/exclude function filters for cron wrappers", async () => {
    const emittedEvents: WideEvent[] = [];
    initWideEvents({
      drains: [async (event) => {
        emittedEvents.push(event);
      }]
    });

    const excludedJob = withCronWideEvent(
      "health-check",
      async () => {
        requireLogger().set({ stillRuns: true });
      },
      {
        excludeNames: ["health-*"]
      }
    );

    const result = await excludedJob();
    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(0);
  });

  it("wraps message handlers and captures inferred message metadata", async () => {
    const emittedEvents: WideEvent[] = [];
    initWideEvents({
      drains: [async (event) => {
        emittedEvents.push(event);
      }]
    });

    const handler = withMessageWideEvent(
      async (_message: { id: string; subject: string }) => {
        requireLogger().set({
          tenant: "acme"
        });
        return "done";
      },
      {
        statusFromResult: () => 202
      }
    );

    const result = await handler(
      {
        id: "msg-1",
        subject: "orders.created"
      },
      {}
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      kind: "message",
      status: 202,
      data: {
        message: {
          id: "msg-1",
          type: "orders.created"
        },
        tenant: "acme"
      }
    });
  });

  it("extracts trace context from message applicationProperties", async () => {
    const emittedEvents: WideEvent[] = [];
    initWideEvents({
      drains: [async (event) => {
        emittedEvents.push(event);
      }]
    });

    const handler = withMessageWideEvent(async () => "done");

    const result = await handler(
      {
        id: "msg-2",
        subject: "billing.updated",
        applicationProperties: {
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
          tracestate: "rojo=00f067aa0ba902b7"
        }
      },
      {}
    );

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      tracestate: "rojo=00f067aa0ba902b7"
    });
  });

  it("supports generic serverless function wrapping", async () => {
    const emittedEvents: WideEvent[] = [];
    initWideEvents({
      drains: [async (event) => {
        emittedEvents.push(event);
      }]
    });

    const handler = withServerlessWideEvent(
      "daily-compaction",
      async (payload: { shards: number }) => {
        requireLogger().set({
          shards: payload.shards
        });
        return {
          compacted: true
        };
      },
      {
        data: (payload) => ({
          trigger: "timer",
          payload
        }),
        statusFromResult: (result) => (result.compacted ? "compacted" : "skipped")
      }
    );

    const result = await handler({
      shards: 4
    });

    expect(result.isOk()).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      name: "daily-compaction",
      kind: "function",
      status: "compacted",
      data: {
        trigger: "timer",
        shards: 4
      }
    });
  });

  it("returns err in cron wrapper when handler throws", async () => {
    const wrapped = withCronWideEvent("fail-cron", async () => {
      throw new Error("cron boom");
    });

    const result = await wrapped();
    expect(result.isErr()).toBe(true);
  });

  it("returns err in message wrapper when handler throws", async () => {
    const wrapped = withMessageWideEvent(async () => {
      throw new Error("message boom");
    });

    const result = await wrapped(
      {
        messageId: "m-1",
        subject: "x"
      },
      {}
    );

    expect(result.isErr()).toBe(true);
  });

  it("returns err in serverless wrapper when handler throws", async () => {
    const wrapped = withServerlessWideEvent("fail-serverless", async () => {
      throw new Error("serverless boom");
    });

    const result = await wrapped();
    expect(result.isErr()).toBe(true);
  });

  it("flushes detached emits before serverless wrapper resolves", async () => {
    const drainedNames: string[] = [];
    initWideEvents({
      drains: [
        async (event) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          drainedNames.push(event.name);
        }
      ]
    });

    const handler = withServerlessWideEvent("serverless-main", async () => {
      const detachedLogger = createWideEventLogger({
        name: "detached-child"
      });

      runWithLoggerContext(detachedLogger, () => {
        void detachedLogger.emit();
      });
    });

    const result = await handler();
    expect(result.isOk()).toBe(true);
    expect(drainedNames.sort()).toEqual(["detached-child", "serverless-main"]);
  });
});
