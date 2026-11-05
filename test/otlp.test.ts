import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createOtlpDrain,
  createTailSampler,
  errors,
  initWaido,
  withWideEvent,
} from "../src/index.js";
import type { OtlpDrainOptions, WideEventErrorContext } from "../src/index.js";
import { __resetWideEventsForTests } from "#src/runtime.js";

interface KeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: { values: unknown[] };
  };
}

interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  eventName: string;
  body: { stringValue: string };
  attributes: KeyValue[];
  traceId?: string;
  spanId?: string;
  flags?: number;
}

interface LogsRequest {
  resourceLogs: Array<{
    resource: { attributes: KeyValue[] };
    scopeLogs: Array<{ scope: { name: string }; logRecords: LogRecord[] }>;
  }>;
}

interface ReceivedRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: LogsRequest;
}

type Reply = { status: number; headers?: Record<string, string>; body?: string };

function attributesOf(record: { attributes: KeyValue[] }): Record<string, KeyValue["value"]> {
  return Object.fromEntries(record.attributes.map((entry) => [entry.key, entry.value]));
}

function recordsOf(requests: ReceivedRequest[]): LogRecord[] {
  return requests.flatMap((request) =>
    request.body.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
}

describe("createOtlpDrain", () => {
  let receiver: Server;
  let endpoint = "";
  let requests: ReceivedRequest[] = [];
  let replies: Reply[] = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          method: request.method ?? "",
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) as LogsRequest,
        });

        const reply = replies.shift() ?? { status: 200 };
        response
          .writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
          .end(reply.body ?? "{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  });

  beforeEach(() => {
    __resetWideEventsForTests();
    requests = [];
    replies = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setup(options: OtlpDrainOptions = {}, config: Parameters<typeof initWaido>[0] = {}) {
    const failures: Array<{ error: Error; context: WideEventErrorContext }> = [];
    const runtime = initWaido({
      service: "test-service",
      environment: "test",
      drains: [
        createOtlpDrain({ endpoint, initialRetryDelayMs: 1, flushIntervalMs: 60_000, ...options }),
      ],
      onError: (error, context) => void failures.push({ error: error as Error, context }),
      ...config,
    });

    return { failures, runtime };
  }

  describe("the request", () => {
    it("posts JSON to /v1/logs", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/logs",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
    });

    it("describes the service in the resource", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      const [resourceLogs] = requests[0].body.resourceLogs;
      expect(attributesOf(resourceLogs.resource)).toEqual({
        "service.name": { stringValue: "test-service" },
        "deployment.environment.name": { stringValue: "test" },
      });
      expect(resourceLogs.scopeLogs[0].scope.name).toBe("waido");
    });

    it("encodes an event as a log record", async () => {
      const { runtime } = setup({}, { now: () => new Date("2026-01-01T00:00:00.000Z") });

      await withWideEvent(
        {
          name: "checkout",
          traceContext: {
            traceId: "a".repeat(32),
            parentSpanId: "b".repeat(16),
            traceSampled: true,
          },
        },
        (event) => {
          event.setFields({
            user: { id: "u1" },
            count: 3,
            ratio: 0.5,
            flag: true,
            tags: ["a", "b"],
            items: [{ sku: "x" }],
          });
        },
      );
      await runtime.flush();

      const [record] = recordsOf(requests);
      expect(record).toMatchObject({
        timeUnixNano: "1767225600000000000",
        severityNumber: 9,
        severityText: "INFO",
        eventName: "waido.wide_event",
        body: { stringValue: "checkout" },
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        flags: 1,
      });
      expect(attributesOf(record)).toMatchObject({
        "user.id": { stringValue: "u1" },
        count: { intValue: "3" },
        ratio: { doubleValue: 0.5 },
        flag: { boolValue: true },
        tags: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } },
        items: { stringValue: '[{"sku":"x"}]' },
        "waido.outcome": { stringValue: "success" },
        "waido.sample_rate": { intValue: "1" },
        "waido.sampling.reason": { stringValue: "default_keep" },
      });
    });

    it("maps the first error to exception attributes and counts all of them", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, (event) => {
        event.addError(new TypeError("first"));
        for (let index = 0; index < 11; index += 1) {
          event.addError(new Error(`other ${index}`));
        }
      });
      await runtime.flush();

      const [record] = recordsOf(requests);
      expect(record.severityText).toBe("ERROR");
      expect(record.severityNumber).toBe(17);

      const attributes = attributesOf(record);
      expect(attributes).toMatchObject({
        "error.type": { stringValue: "TypeError" },
        "exception.type": { stringValue: "TypeError" },
        "exception.message": { stringValue: "first" },
        "waido.error_count": { intValue: "12" },
      });
      expect(attributes["exception.stacktrace"].stringValue).toContain("TypeError: first");
    });

    it("leaves out trace fields that aren't valid", async () => {
      const { runtime } = setup();

      await withWideEvent(
        { name: "job", traceContext: { traceId: "not-hex", spanId: "also-not" } },
        () => undefined,
      );
      await runtime.flush();

      expect(recordsOf(requests)[0]).not.toHaveProperty("traceId");
    });

    it("carries the tail sampler's rate and rule", async () => {
      const { runtime } = setup(
        {},
        { sampler: createTailSampler({ keep: [errors()], rate: 0.05, random: () => 0 }) },
      );

      await withWideEvent({ name: "kept-by-rate" }, () => undefined);
      await withWideEvent({ name: "kept-by-rule" }, (event) => {
        event.addError(new Error("boom"));
      });
      await runtime.flush();

      const [byRate, byRule] = recordsOf(requests);
      expect(attributesOf(byRate)["waido.sample_rate"]).toEqual({ intValue: "20" });
      expect(attributesOf(byRule)).toMatchObject({
        "waido.sample_rate": { intValue: "1" },
        "waido.sampling.rule": { stringValue: "errors" },
      });
    });

    it("sends nothing for dropped events", async () => {
      const { runtime } = setup({}, { sampler: () => false });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests).toHaveLength(0);
    });

    it("supports a custom sample rate attribute", async () => {
      const { runtime } = setup({ sampleRateAttribute: "SampleRate" });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      const attributes = attributesOf(recordsOf(requests)[0]);
      expect(attributes.SampleRate).toEqual({ intValue: "1" });
      expect(attributes).not.toHaveProperty("waido.sample_rate");
    });
  });

  describe("batching", () => {
    it("sends once a batch is full, without waiting for a flush", async () => {
      const { runtime } = setup({ maxBatchSize: 2 });

      await withWideEvent({ name: "one" }, () => undefined);
      await withWideEvent({ name: "two" }, () => undefined);

      await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
      });
      expect(recordsOf(requests).map((record) => record.body.stringValue)).toEqual(["one", "two"]);
      await runtime.flush();
    });

    it("sends a partial batch after the interval", async () => {
      const { runtime } = setup({ flushIntervalMs: 10 });

      await withWideEvent({ name: "job" }, () => undefined);

      await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
      });
      await runtime.flush();
    });

    it("splits what's waiting into batches on flush", async () => {
      const { runtime } = setup({ maxBatchSize: 2 });

      for (const name of ["a", "b", "c", "d", "e"]) {
        await withWideEvent({ name }, () => undefined);
      }

      await expect(runtime.flush()).resolves.toEqual({ completed: true, pending: 0 });
      expect(recordsOf(requests)).toHaveLength(5);
      expect(requests.length).toBeGreaterThanOrEqual(3);
    });

    it("sends everything on destroy", async () => {
      const { runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);

      await expect(runtime.destroy()).resolves.toMatchObject({ completed: true });
      expect(requests).toHaveLength(1);
    });

    it("sends what's waiting when the runtime is replaced", async () => {
      setup();
      await withWideEvent({ name: "before-replacing" }, () => undefined);

      const second = initWaido({ drains: [] });
      await second.flush();

      expect(recordsOf(requests)[0].body.stringValue).toBe("before-replacing");
    });

    it("drops events and reports it when the queue is full", async () => {
      const { failures, runtime } = setup({ maxQueueSize: 1, maxBatchSize: 10 });

      await withWideEvent({ name: "kept" }, () => undefined);
      await withWideEvent({ name: "dropped" }, () => undefined);
      await runtime.flush();

      expect(recordsOf(requests).map((record) => record.body.stringValue)).toEqual(["kept"]);
      expect(failures[0].context).toMatchObject({ stage: "drain", eventName: "dropped" });
      expect(failures[0].error.message).toContain("queue is full");
    });
  });

  describe("failures", () => {
    it.each([429, 502, 503, 504])("retries a %i response", async (status) => {
      replies = [{ status }];
      const { failures, runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests).toHaveLength(2);
      expect(failures).toEqual([]);
    });

    it("honours Retry-After", async () => {
      replies = [{ status: 503, headers: { "retry-after": "0.05" } }];
      const { runtime } = setup({ initialRetryDelayMs: 60_000 });

      await withWideEvent({ name: "job" }, () => undefined);
      const startedAt = Date.now();
      await runtime.flush();

      expect(requests).toHaveLength(2);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    it("gives up after maxRetries and reports it", async () => {
      replies = [{ status: 503 }, { status: 503 }, { status: 503 }];
      const { failures, runtime } = setup({ maxRetries: 2 });

      await withWideEvent({ name: "job" }, () => undefined);
      await expect(runtime.flush()).resolves.toMatchObject({ completed: true });

      expect(requests).toHaveLength(3);
      expect(failures).toHaveLength(1);
      expect(failures[0].error.message).toContain("status 503");
      expect(failures[0].context.stage).toBe("drain");
    });

    it.each([400, 401, 500])("doesn't retry a %i response", async (status) => {
      replies = [{ status }];
      const { failures, runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests).toHaveLength(1);
      expect(failures[0].error.message).toContain(`status ${status}`);
    });

    it("reports events the receiver partly rejected", async () => {
      replies = [
        { status: 200, body: JSON.stringify({ partialSuccess: { rejectedLogRecords: "1" } }) },
      ];
      const { failures, runtime } = setup();

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests).toHaveLength(1);
      expect(failures[0].error.message).toContain("rejected 1 of 1");
    });

    it("retries when the receiver can't be reached, then reports it", async () => {
      const { failures, runtime } = setup({ endpoint: "http://127.0.0.1:1", maxRetries: 1 });

      await expect(withWideEvent({ name: "job" }, () => "work result")).resolves.toBe(
        "work result",
      );
      await expect(runtime.flush()).resolves.toMatchObject({ completed: true });

      expect(failures[0].error.message).toContain("OTLP export failed");
    });

    it("leaves the flush incomplete if retries outlast its timeout", async () => {
      replies = [{ status: 503 }];
      const { runtime } = setup({ initialRetryDelayMs: 100 });

      await withWideEvent({ name: "job" }, () => undefined);

      await expect(runtime.flush({ timeoutMs: 10 })).resolves.toMatchObject({ completed: false });
      await expect(runtime.flush()).resolves.toMatchObject({ completed: true });
    });

    it("never puts credentials in reported errors", async () => {
      replies = [{ status: 401 }];
      const { failures, runtime } = setup({
        endpoint: endpoint.replace("http://", "http://user:hunter2@"),
        headers: { authorization: "Bearer hunter2" },
      });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(failures[0].error.message).not.toContain("hunter2");
    });
  });

  describe("configuration", () => {
    it("throws at startup with no endpoint", () => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
      expect(() => createOtlpDrain()).toThrow("needs an endpoint");
    });

    it("throws at startup for an invalid endpoint", () => {
      expect(() => createOtlpDrain({ endpoint: "not a url" })).toThrow("valid URL");
      expect(() => createOtlpDrain({ endpoint: "ftp://example.com" })).toThrow("http or https");
    });

    it("throws at startup for invalid limits", () => {
      expect(() => createOtlpDrain({ endpoint, maxBatchSize: 0 })).toThrow(RangeError);
      expect(() => createOtlpDrain({ endpoint, maxRetries: -1 })).toThrow(RangeError);
    });

    it("doesn't add the logs path twice", async () => {
      const { runtime } = setup({ endpoint: `${endpoint}/v1/logs/` });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests[0].url).toBe("/v1/logs");
    });

    it("keeps a base path", async () => {
      const { runtime } = setup({ endpoint: `${endpoint}/otlp` });

      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests[0].url).toBe("/otlp/v1/logs");
    });

    it("reads the standard environment variables", async () => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-team=a%20b, x-key=value=with=equals,malformed");
      vi.stubEnv("OTEL_SERVICE_NAME", "from-env");

      const runtime = initWaido({ environment: "test", drains: [createOtlpDrain()] });
      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests[0].headers).toMatchObject({
        "x-team": "a b",
        "x-key": "value=with=equals",
      });
      expect(attributesOf(requests[0].body.resourceLogs[0].resource)["service.name"]).toEqual({
        stringValue: "from-env",
      });
    });

    it("prefers options over the environment", async () => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1");
      vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-team=env");

      const { runtime } = setup({ endpoint, headers: { "x-team": "option" } });
      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(requests[0].headers["x-team"]).toBe("option");
    });

    it("prefers the runtime's service over OTEL_SERVICE_NAME", async () => {
      vi.stubEnv("OTEL_SERVICE_NAME", "from-env");

      const { runtime } = setup();
      await withWideEvent({ name: "job" }, () => undefined);
      await runtime.flush();

      expect(attributesOf(requests[0].body.resourceLogs[0].resource)["service.name"]).toEqual({
        stringValue: "test-service",
      });
    });
  });
});
