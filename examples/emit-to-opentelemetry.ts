import { logs, trace } from "@opentelemetry/api";
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { createTailSampler, errors, initWaido, withWideContext } from "waido";
import { otel } from "waido/otel";

// Your application owns the SDK. Swap the console exporters for OTLP ones in production.
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() })],
});
logs.setGlobalLoggerProvider(loggerProvider);

const waido = initWaido({
  service: "otel-demo",
  sampler: createTailSampler({ keep: [errors()], rate: 0 }),
  integrations: [otel()],
});

const tracer = trace.getTracer("example");

await tracer.startActiveSpan("checkout", async (span) => {
  // Sampled out, so no log record. The fields still land on the span.
  await withWideContext({ name: "checkout", kind: "function" }, (log) => {
    log.setFields({ order: { id: "ord_111", total: 12_000 } });
  });

  span.end();
});

await tracer.startActiveSpan("refund", async (span) => {
  // Kept by the errors() rule, so it is exported as a log record too.
  await withWideContext({ name: "refund", kind: "function" }, (log) => {
    log.setFields({ order: { id: "ord_111" } });
    log.error(new Error("Refund rejected"));
  });

  span.end();
});

await waido.destroy();
await tracerProvider.shutdown();
await loggerProvider.shutdown();
