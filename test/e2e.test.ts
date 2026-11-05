import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string | number; doubleValue?: number };
}

interface OtlpSpan {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  attributes: OtlpKeyValue[];
  events?: Array<{ name: string }>;
  status?: { code?: number };
}

interface OtlpLogRecord {
  traceId?: string;
  spanId?: string;
  eventName?: string;
  severityText?: string;
  body?: { stringValue?: string };
  attributes: OtlpKeyValue[];
}

const ROOT = join(import.meta.dirname, "..");
const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

function attribute(record: { attributes: OtlpKeyValue[] }, key: string): unknown {
  const value = record.attributes.find((entry) => entry.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue;
}

/**
 * Sends requests through the published package entry points, real instrumentation and the real OTLP
 * exporters, then checks what arrives at a local receiver. No account or network is involved.
 */
describe("end to end over OTLP", () => {
  const spans: OtlpSpan[] = [];
  const logs: OtlpLogRecord[] = [];
  let receiver: Server;
  let app: ChildProcess;
  let baseUrl = "";
  let flushResult: unknown;

  function serverSpan(route: string): OtlpSpan | undefined {
    return spans.find(
      (span) => span.kind === SPAN_KIND_SERVER && attribute(span, "http.route") === route,
    );
  }

  beforeAll(async () => {
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    execFileSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: ROOT });

    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          resourceSpans?: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
          resourceLogs?: Array<{ scopeLogs: Array<{ logRecords: OtlpLogRecord[] }> }>;
        };

        for (const resource of body.resourceSpans ?? []) {
          spans.push(...resource.scopeSpans.flatMap((scope) => scope.spans));
        }
        for (const resource of body.resourceLogs ?? []) {
          logs.push(...resource.scopeLogs.flatMap((scope) => scope.logRecords));
        }

        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));

    app = fork(join(ROOT, "test/fixtures/otel-app.cjs"), {
      cwd: ROOT,
      env: {
        ...process.env,
        OTEL_SEMCONV_STABILITY_OPT_IN: "http",
        OTLP_ENDPOINT: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`,
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      app.once("message", (message) => resolve((message as { port: number }).port));
      app.once("exit", (code) => reject(new Error(`The app exited early with code ${code}`)));
    });
    baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/users/42`, {
      headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` },
    });
    await fetch(`${baseUrl}/handled`);
    await fetch(`${baseUrl}/fail?token=SECRET`);

    flushResult = await new Promise((resolve) => {
      app.on("message", (message) => resolve((message as { flushed: unknown }).flushed));
      app.send("shutdown");
    });
  }, 60_000);

  afterAll(async () => {
    app?.kill();
    await new Promise((resolve) => receiver?.close(resolve));
  });

  it("finishes all waido work before shutting down", () => {
    expect(flushResult).toEqual({ completed: true, pending: 0 });
  });

  it("enriches the server span, even though the event was sampled out", () => {
    const span = serverSpan("/users/:id");

    expect(span).toBeDefined();
    expect(span?.traceId).toBe("a".repeat(32));
    expect(attribute(span!, "user.id")).toBe("42");
    expect(attribute(span!, "waido.outcome")).toBe("success");
    expect(attribute(span!, "http.request.method")).toBe("GET");
    expect(attribute(span!, "url.path")).toBe("/users/42");
    expect(attribute(span!, "waido.sample_rate")).toBeUndefined();
  });

  it("redacts fields before they reach the span", () => {
    expect(attribute(serverSpan("/users/:id")!, "user.email")).toBe("[REDACTED]");
    expect(JSON.stringify(spans)).not.toContain("secret@example.com");
  });

  it("marks the span of a failed request as an error", () => {
    const span = serverSpan("/fail");

    expect(span?.status?.code).toBe(STATUS_ERROR);
    expect(Number(attribute(span!, "waido.error_count"))).toBe(1);
    expect(span?.events?.map((event) => event.name)).toContain("exception");
  });

  it("marks the span as an error when a handled error returned a 200", () => {
    const span = serverSpan("/handled");

    expect(Number(attribute(span!, "http.response.status_code"))).toBe(200);
    expect(span?.status?.code).toBe(STATUS_ERROR);
    expect(attribute(span!, "waido.outcome")).toBe("error");
  });

  it("sends only kept events as log records", () => {
    expect(logs.map((record) => record.body?.stringValue)).toEqual(["GET /handled", "GET /fail"]);
  });

  it("sends a complete log record, correlated with the trace", () => {
    const record = logs.find((log) => log.body?.stringValue === "GET /fail")!;
    const span = serverSpan("/fail");

    expect(record.eventName).toBe("waido.wide_event");
    expect(record.severityText).toBe("ERROR");
    expect(record.traceId).toBe(span?.traceId);
    expect(record.spanId).toBe(span?.spanId);
    expect(attribute(record, "http.route")).toBe("/fail");
    expect(attribute(record, "exception.type")).toBe("TypeError");
    expect(attribute(record, "exception.message")).toBe("payment failed");
    expect(Number(attribute(record, "waido.sample_rate"))).toBe(1);
    expect(attribute(record, "waido.sampling.rule")).toBe("errors");
  });

  it("never exports the query string", () => {
    expect(JSON.stringify(logs)).not.toContain("SECRET");
    const waidoFields = serverSpan("/fail")?.attributes.filter((entry) =>
      entry.key.startsWith("waido."),
    );
    expect(JSON.stringify(waidoFields)).not.toContain("SECRET");
  });
});
