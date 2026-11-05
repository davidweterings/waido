import {
  createConsoleDrain,
  createRedactor,
  createStructuredError,
  createWideEventLogger,
  flushWideEvents,
  initWaido,
  runWithLoggerContext,
  useLogger,
  withWideContext,
} from "../src/index.js";
import type { WideEvent, WideEventErrorContext, WideEventRuntimeConfig } from "../src/index.js";
import { __resetWideEventsForTests } from "#src/runtime.js";

function setup(config: WideEventRuntimeConfig = {}) {
  const events: WideEvent[] = [];
  const failures: Array<{ error: unknown; context: WideEventErrorContext }> = [];
  const runtime = initWaido({
    drains: [(event) => void events.push(event)],
    onError: (error, context) => void failures.push({ error, context }),
    ...config,
  });

  return { events, failures, runtime };
}

describe("runtime", () => {
  beforeEach(() => {
    __resetWideEventsForTests();
  });

  describe("withWideContext", () => {
    it("shares one event through AsyncLocalStorage", async () => {
      const { events, runtime } = setup({ service: "test-service" });

      await withWideContext({ name: "unit-job", kind: "function" }, async () => {
        useLogger().setFields({ user: { id: "user_123" } });
        await Promise.resolve();
        useLogger().setFields({ user: { tier: "pro" }, step: "done" });
      });
      await runtime.flush();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        service: "test-service",
        name: "unit-job",
        kind: "function",
        outcome: "success",
        data: { user: { id: "user_123", tier: "pro" }, step: "done" },
      });
    });

    it("returns the work's value", async () => {
      setup();
      await expect(withWideContext({ name: "job" }, () => 42)).resolves.toBe(42);
    });

    it("rethrows the work's error unchanged and records it", async () => {
      const { events, runtime } = setup();
      const failure = new Error("boom");

      await expect(
        withWideContext({ name: "job" }, () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      await runtime.flush();

      expect(events[0]).toMatchObject({ outcome: "error", errors: [{ message: "boom" }] });
    });

    it("runs work with a no-op logger when the runtime isn't initialized", async () => {
      const result = await withWideContext({ name: "job" }, (log) => {
        log.set("ignored", true);
        return "done";
      });

      expect(result).toBe("done");
      expect(useLogger().emit()).toBeUndefined();
    });

    it("doesn't let a failing drain affect the result", async () => {
      const { failures, runtime } = setup({
        drains: [
          () => {
            throw new Error("sink down");
          },
        ],
      });

      await expect(withWideContext({ name: "job" }, () => "ok")).resolves.toBe("ok");
      await runtime.flush();

      expect(failures[0].context).toMatchObject({ stage: "drain", eventName: "job", index: 0 });
    });

    it("doesn't wait for slow drains", async () => {
      let release!: () => void;
      const { runtime } = setup({
        drains: [
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ],
      });

      await expect(withWideContext({ name: "job" }, () => "ok")).resolves.toBe("ok");

      const flushed = runtime.flush({ timeoutMs: 1_000 });
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await expect(flushed).resolves.toEqual({ completed: true, pending: 0 });
    });
  });

  describe("outcome", () => {
    async function outcomeOf(work: (log: ReturnType<typeof useLogger>) => void) {
      const { events, runtime } = setup();
      const logger = createWideEventLogger({ name: "job" });
      work(logger);
      logger.emit();
      await runtime.flush();
      return events[0].outcome;
    }

    it("is error when an error was recorded, even with a 2xx status", async () => {
      await expect(
        outcomeOf((log) => {
          log.error(new Error("handled"));
          log.setStatus(200);
        }),
      ).resolves.toBe("error");
    });

    it("lets an explicit outcome win over a recorded error", async () => {
      await expect(
        outcomeOf((log) => {
          log.error(new Error("recovered by retry"));
          log.setOutcome("success");
        }),
      ).resolves.toBe("success");
    });

    it("is error for a 5xx status", async () => {
      await expect(outcomeOf((log) => log.setStatus(503))).resolves.toBe("error");
    });

    it("is success for a 4xx status with no recorded error", async () => {
      await expect(outcomeOf((log) => log.setStatus(404))).resolves.toBe("success");
    });

    it("prefers a recorded error over aborted", async () => {
      const { events, runtime } = setup();
      const logger = createWideEventLogger({ name: "job" });
      logger.error(new Error("failed first"));
      logger.emit({ aborted: true });
      await runtime.flush();
      expect(events[0].outcome).toBe("error");
    });

    it("prefers aborted over a 5xx status", async () => {
      const { events, runtime } = setup();
      createWideEventLogger({ name: "job" }).emit({ aborted: true, status: 500 });
      await runtime.flush();
      expect(events[0].outcome).toBe("aborted");
    });
  });

  describe("errors", () => {
    it("adds structured why, fix and link fields", async () => {
      const { events, runtime } = setup();

      await withWideContext({ name: "checkout" }, () => {
        throw createStructuredError({
          message: "Payment failed",
          why: "Card declined by issuer",
          fix: "Use another card",
          link: "https://docs.example.com/payments",
          code: "PAYMENT_DECLINED",
        });
      }).catch(() => undefined);
      await runtime.flush();

      expect(events[0].errors[0]).toMatchObject({
        message: "Payment failed",
        why: "Card declined by issuer",
        fix: "Use another card",
        link: "https://docs.example.com/payments",
        code: "PAYMENT_DECLINED",
      });
    });

    it("doesn't record the same error object twice", async () => {
      const { events, runtime } = setup();
      const failure = new Error("boom");

      await withWideContext({ name: "job" }, (log) => {
        log.error(failure);
        throw failure;
      }).catch(() => undefined);
      await runtime.flush();

      expect(events[0].errors).toHaveLength(1);
    });

    it("keeps the first 10 errors and counts the rest", async () => {
      const { events, runtime } = setup();
      const logger = createWideEventLogger({ name: "job" });

      for (let index = 0; index < 13; index += 1) {
        logger.error(new Error(`error ${index}`));
      }
      logger.emit();
      await runtime.flush();

      expect(events[0].errors).toHaveLength(10);
      expect(events[0].errors[0].message).toBe("error 0");
      expect(events[0].errorsDropped).toBe(3);
    });

    it("caps long stacks at 4 KiB", async () => {
      const { events, runtime } = setup();
      const failure = new Error("big");
      failure.stack = "x".repeat(10_000);

      const logger = createWideEventLogger({ name: "job" });
      logger.error(failure);
      logger.emit();
      await runtime.flush();

      expect(events[0].errors[0].stack?.length).toBeLessThanOrEqual(4096);
    });
  });

  describe("unserializable fields", () => {
    it("keeps the event when a field is a BigInt", async () => {
      const { events, runtime } = setup();
      await expect(
        withWideContext({ name: "job" }, (log) => {
          log.set("amount", 10n);
          return "ok";
        }),
      ).resolves.toBe("ok");
      await runtime.flush();
      expect(events[0].data.amount).toBe("10");
    });

    it("keeps the event when a field is circular", async () => {
      const { events, runtime } = setup();
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      await expect(
        withWideContext({ name: "job" }, (log) => {
          log.set("viaSet", circular);
          log.setFields({ viaFields: circular });
          return "ok";
        }),
      ).resolves.toBe("ok");
      await runtime.flush();

      expect(events[0].data.viaSet).toEqual({ a: 1, self: "[Circular]" });
      expect(events[0].data.viaFields).toEqual({ a: 1, self: "[Circular]" });
    });

    it("keeps the event when reading a field throws", async () => {
      const { events, runtime } = setup();
      const hostile = {
        get boom(): string {
          throw new Error("getter failed");
        },
      };

      await withWideContext({ name: "job" }, (log) => {
        log.set("hostile", hostile);
      });
      await runtime.flush();

      expect(events[0].data.hostile).toBe("[Unserializable]");
    });

    it("converts common non-JSON values", async () => {
      const { events, runtime } = setup();

      await withWideContext({ name: "job" }, (log) => {
        log.setFields({
          date: new Date(0),
          map: new Map([["key", 1]]),
          set: new Set([1, 2]),
          nan: Number.NaN,
          bytes: Buffer.from("abc"),
          fn: () => 1,
          nested: new Error("inner"),
        });
      });
      await runtime.flush();

      expect(events[0].data).toEqual({
        date: "1970-01-01T00:00:00.000Z",
        map: { key: 1 },
        set: [1, 2],
        nan: "NaN",
        bytes: "[Binary 3 bytes]",
        nested: { name: "Error", message: "inner" },
      });
    });

    it("doesn't pollute Object.prototype from untrusted input", async () => {
      const { events, runtime } = setup();
      const untrusted = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as object;

      await withWideContext({ name: "job", data: untrusted }, (log) => {
        log.setFields(untrusted);
        log.setFields("__proto__", { polluted: true });
        log.set("__proto__", { polluted: true });
      });
      await runtime.flush();

      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(events[0].data).toEqual({ safe: 1 });
    });
  });

  describe("payload limit", () => {
    it("truncates the largest fields and keeps small ones", async () => {
      const { events, runtime } = setup({ payloadPolicy: { maxBytes: 800 } });

      await withWideContext(
        {
          name: "oversized",
          data: { user: { id: "u1", bio: "x".repeat(2000) }, keep: "ok" },
        },
        () => undefined,
      );
      await runtime.flush();

      expect(events[0].data).toEqual({ user: { id: "u1", bio: "[Truncated]" }, keep: "ok" });
      expect(events[0].payload).toMatchObject({ truncated: true, maxBytes: 800 });
      expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(800);
    });

    it("applies a 64 KiB limit by default", async () => {
      const { events, runtime } = setup();

      await withWideContext({ name: "big", data: { blob: "x".repeat(100_000) } }, () => undefined);
      await runtime.flush();

      expect(events[0].payload).toMatchObject({ truncated: true, maxBytes: 65_536 });
      expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(65_536);
    });

    it("keeps an oversized error event, with its error intact", async () => {
      const { events, runtime } = setup({ payloadPolicy: { maxBytes: 1_500 } });

      await withWideContext({ name: "big-error" }, (log) => {
        log.set("blob", "x".repeat(5_000));
        throw new Error("payment failed");
      }).catch(() => undefined);
      await runtime.flush();

      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe("error");
      expect(events[0].errors[0].message).toBe("payment failed");
    });

    it("stays within the limit when errors alone would exceed it", async () => {
      const { events, runtime } = setup({ payloadPolicy: { maxBytes: 4_000 } });
      const logger = createWideEventLogger({ name: "many-errors" });

      for (let index = 0; index < 10; index += 1) {
        const failure = new Error(`failure ${index}`);
        failure.stack = "s".repeat(4_000);
        logger.error(failure);
      }
      logger.emit();
      await runtime.flush();

      expect(events[0].errors).toHaveLength(10);
      expect(events[0].errors[9].message).toBe("failure 9");
      expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(4_000);
    });

    it("rejects an invalid limit at startup", () => {
      expect(() => initWaido({ payloadPolicy: { maxBytes: 0 } })).toThrow(RangeError);
    });
  });

  describe("pipeline", () => {
    it("runs enrichers, then redaction, then the size limit, then the sampler", async () => {
      const seenBySampler: unknown[] = [];
      const { events, runtime } = setup({
        enrichers: [
          ({ event }) => {
            event.data.user = { email: "added@by.enricher" };
          },
        ],
        redact: createRedactor({ paths: ["user.email"] }),
        sampler: (event) => {
          seenBySampler.push({ data: event.data, truncated: event.payload.truncated });
          return true;
        },
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(seenBySampler).toEqual([
        { data: { user: { email: "[REDACTED]" } }, truncated: false },
      ]);
      expect(events[0].data.user.email).toBe("[REDACTED]");
    });

    it("reports an async enricher instead of waiting for it", async () => {
      const { events, failures, runtime } = setup({
        enrichers: [
          (async ({ event }: { event: { data: Record<string, unknown> } }) => {
            await Promise.resolve();
            event.data.late = true;
          }) as never,
        ],
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].data).toEqual({});
      expect(failures[0].context.stage).toBe("enricher");
    });

    it("isolates a failing enricher", async () => {
      const { events, failures, runtime } = setup({
        enrichers: [
          () => {
            throw new Error("enricher failed");
          },
          ({ event }) => {
            event.data.second = true;
          },
        ],
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].data.second).toBe(true);
      expect(failures[0].context).toMatchObject({ stage: "enricher", index: 0 });
    });

    it("keeps the event when the sampler fails", async () => {
      const { events, failures, runtime } = setup({
        sampler: () => {
          throw new Error("sampler failed");
        },
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].sampling.reason).toBe("sampler_error");
      expect(failures[0].context.stage).toBe("sampler");
    });

    it("removes all fields when redaction fails, rather than leaking them", async () => {
      const { events, failures, runtime } = setup({
        redact: () => {
          throw new Error("redactor failed");
        },
      });

      await withWideContext({ name: "job", data: { secret: "value" } }, () => undefined);
      await runtime.flush();

      expect(events[0].data).toEqual({ __redactionFailed: true });
      expect(failures[0].context.stage).toBe("redact");
    });

    it("lets a forced sampling decision override the sampler", async () => {
      const { events, runtime } = setup({ sampler: () => false });

      await withWideContext({ name: "job" }, (log) => {
        log.setSamplingDecision({ sampled: true, reason: "vip" });
      });
      await runtime.flush();

      expect(events[0].sampling).toMatchObject({ reason: "vip", sampleRate: 1 });
    });

    it("returns the kept event from emit, undefined when dropped, and emits once", async () => {
      const { events, runtime } = setup();
      const logger = createWideEventLogger({ name: "job" });

      const first = logger.emit();
      expect(first?.name).toBe("job");
      expect(logger.emit()).toBe(first);
      await runtime.flush();
      expect(events).toHaveLength(1);

      initWaido({ sampler: () => false, drains: [] });
      expect(createWideEventLogger({ name: "dropped" }).emit()).toBeUndefined();
    });
  });

  describe("nesting and late writes", () => {
    it("emits a nested scope as its own event, linked to the parent and its trace", async () => {
      const { events, runtime } = setup();
      let parentId: string | undefined;

      await withWideContext(
        { name: "parent", traceContext: { traceId: "a".repeat(32), spanId: "b".repeat(16) } },
        async (parent) => {
          parentId = parent.id;
          await withWideContext({ name: "child" }, (child) => {
            child.set("level", "child");
          });
        },
      );
      await runtime.flush();

      const child = events.find((event) => event.name === "child");
      const parent = events.find((event) => event.name === "parent");
      expect(parent?.parentId).toBeUndefined();
      expect(child).toMatchObject({
        parentId,
        traceId: "a".repeat(32),
        parentSpanId: "b".repeat(16),
        data: { level: "child" },
      });
      expect(child?.spanId).toBeUndefined();
    });

    it("ignores writes after emit and reports the first one", async () => {
      const { events, failures, runtime } = setup();
      const logger = createWideEventLogger({ name: "job" });

      logger.emit();
      logger.set("late", 1);
      logger.set("later", 2);
      await runtime.flush();

      expect(events[0].data).toEqual({});
      expect(failures).toHaveLength(1);
      expect(failures[0].context).toMatchObject({ stage: "late_write", eventName: "job" });
    });
  });

  describe("filter", () => {
    it("gives filtered work a no-op logger", async () => {
      const seen: string[] = [];
      const { events, runtime } = setup({
        filter: (input) => input.name !== "noise",
        enrichers: [({ event }) => void seen.push(event.name)],
      });

      await withWideContext({ name: "noise" }, (log) => {
        log.error(new Error("still excluded"));
      });
      await runtime.flush();

      expect(events).toHaveLength(0);
      expect(seen).toHaveLength(0);
    });

    it("captures the work when the filter fails", async () => {
      const { events, failures, runtime } = setup({
        filter: () => {
          throw new Error("filter failed");
        },
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events).toHaveLength(1);
      expect(failures[0].context.stage).toBe("filter");
    });
  });

  describe("drains", () => {
    it("writes JSON lines to stdout when no drains are configured", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const runtime = initWaido();

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ name: "job" });
      log.mockRestore();
    });

    it("writes nothing when drains is explicitly empty", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const runtime = initWaido({ drains: [] });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it("skips the stdout default when an integration provides a drain", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const events: WideEvent[] = [];
      const runtime = initWaido({
        integrations: [{ name: "sink", drain: (event) => void events.push(event) }],
      });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(log).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      log.mockRestore();
    });

    it("supports a custom console drain writer", async () => {
      const lines: string[] = [];
      const runtime = initWaido({ drains: [createConsoleDrain({ writer: (l) => lines.push(l) })] });

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(JSON.parse(lines[0])).toMatchObject({ name: "job" });
    });

    it("reports a drain that exceeds its time limit and stops tracking it", async () => {
      const { failures, runtime } = setup({
        emitTimeoutMs: 10,
        drains: [() => new Promise<void>(() => undefined)],
      });

      await withWideContext({ name: "job" }, () => undefined);

      await expect(runtime.flush({ timeoutMs: 1_000 })).resolves.toEqual({
        completed: true,
        pending: 0,
      });
      expect(failures[0].context).toMatchObject({ stage: "drain_timeout", index: 0 });
    });

    it("rejects a non-function drain at startup", () => {
      expect(() => initWaido({ drains: ["nope" as never] })).toThrow(TypeError);
    });
  });

  describe("flush and destroy", () => {
    it("waits for pending drains", async () => {
      const names: string[] = [];
      const { runtime } = setup({
        drains: [
          async (event) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            names.push(event.name);
          },
        ],
      });

      createWideEventLogger({ name: "async-flush" }).emit();

      await expect(flushWideEvents()).resolves.toEqual({ completed: true, pending: 0 });
      expect(names).toEqual(["async-flush"]);
      await runtime.destroy();
    });

    it("waits for active scopes", async () => {
      const { events } = setup();
      let release!: () => void;

      const work = withWideContext({ name: "active" }, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });

      let settled = false;
      const flushed = flushWideEvents({ timeoutMs: 1_000 }).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      release();
      await work;
      await expect(flushed).resolves.toEqual({ completed: true, pending: 0 });
      expect(events).toHaveLength(1);
    });

    it("resolves with completed false on timeout instead of rejecting", async () => {
      const { runtime } = setup({ drains: [() => new Promise<void>(() => undefined)] });

      createWideEventLogger({ name: "stuck" }).emit();

      await expect(runtime.flush({ timeoutMs: 10 })).resolves.toEqual({
        completed: false,
        pending: 1,
      });
    });

    it("resets the runtime on destroy, even after a timeout", async () => {
      const { events, runtime } = setup({
        drains: [
          (event) => {
            events.push(event);
            return new Promise<void>(() => undefined);
          },
        ],
      });
      createWideEventLogger({ name: "stuck" }).emit();

      await expect(runtime.destroy({ timeoutMs: 10 })).resolves.toMatchObject({ completed: false });

      expect(createWideEventLogger({ name: "after" }).emit()).toBeUndefined();
    });

    it("doesn't let an old handle shut down a newer runtime", async () => {
      const first = setup();
      const second = setup();

      await first.runtime.destroy();
      await withWideContext({ name: "still-running" }, () => undefined);
      await second.runtime.flush();

      expect(second.events).toHaveLength(1);
    });
  });

  describe("configuration", () => {
    it("replaces the previous configuration rather than merging", async () => {
      setup({ service: "first", sampler: () => false });
      const { events, runtime } = setup();

      await withWideContext({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(events[0].service).toBeUndefined();
    });

    it("survives an onError handler that throws", async () => {
      const { runtime } = setup({
        drains: [
          () => {
            throw new Error("sink down");
          },
        ],
        onError: () => {
          throw new Error("handler failed");
        },
      });

      await withWideContext({ name: "job" }, () => undefined);
      await expect(runtime.flush()).resolves.toMatchObject({ completed: true });
    });
  });

  describe("useLogger", () => {
    it("is a silent no-op outside any context", () => {
      const log = useLogger();
      log.setFields({ ignored: true });
      log.increment("counter");
      log.append("list", "item");
      log.error(new Error("ignored"));
      expect(log.hasEmitted()).toBe(false);
      expect(log.emit()).toBeUndefined();
    });

    it("works inside runWithLoggerContext", async () => {
      const { events, runtime } = setup();
      const logger = createWideEventLogger({ name: "manual" });

      runWithLoggerContext(logger, () => {
        useLogger().increment("count").increment("count", 2).append("items", "a");
        useLogger().time("step");
        useLogger().timeEnd("step");
        useLogger().setStatus(201);
      });
      logger.emit();
      await runtime.flush();

      expect(events[0]).toMatchObject({
        status: 201,
        data: { count: 3, items: ["a"], timings: { step: expect.any(Number) } },
      });
    });
  });

  describe("trace context", () => {
    it("uses the runtime extractor over input", async () => {
      const { events, runtime } = setup({
        traceContextExtractor: () => ({ traceId: "e".repeat(32), spanId: "f".repeat(16) }),
      });

      await withWideContext(
        { name: "job", traceContext: { traceId: "a".repeat(32), parentSpanId: "b".repeat(16) } },
        () => undefined,
      );
      await runtime.flush();

      expect(events[0]).toMatchObject({ traceId: "e".repeat(32), spanId: "f".repeat(16) });
      expect(events[0].parentSpanId).toBeUndefined();
    });

    it("keeps a parent span ID when the layers agree on the trace", async () => {
      const { events, runtime } = setup({
        integrations: [
          {
            name: "stub",
            begin: () => ({
              traceContext: { traceId: "a".repeat(32), spanId: "c".repeat(16) },
            }),
          },
        ],
        drains: [(event) => void events.push(event)],
      });

      await withWideContext(
        { name: "job", traceContext: { traceId: "a".repeat(32), parentSpanId: "b".repeat(16) } },
        () => undefined,
      );
      await runtime.flush();

      expect(events[0]).toMatchObject({ spanId: "c".repeat(16), parentSpanId: "b".repeat(16) });
    });
  });
});
