// A real application: real SDK, real auto-instrumentation, real OTLP/HTTP exporters.
// Runs as its own process because instrumentation must patch modules before they load.
const { logs } = require("@opentelemetry/api");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { LoggerProvider, SimpleLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");

const endpoint = process.env.OTLP_ENDPOINT;
const resource = resourceFromAttributes({ "service.name": "e2e-app" });

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [
    new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
  ],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new SimpleLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    }),
  ],
});
logs.setGlobalLoggerProvider(loggerProvider);

registerInstrumentations({
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

const express = require("express");

async function main() {
  const { createRedactor, createTailSampler, errors, initWaido, useWideEvent } =
    await import("waido");
  const { createExpressErrorMiddleware, createExpressWideEventMiddleware } =
    await import("waido/express");
  const { otel } = await import("waido/otel");

  const waido = initWaido({
    service: "e2e-app",
    // Successes are dropped, so only errors should arrive as log records.
    sampler: createTailSampler({ keep: [errors()], rate: 0 }),
    redact: createRedactor({ paths: ["user.email"] }),
    integrations: [otel()],
  });

  const app = express();
  app.use(createExpressWideEventMiddleware());

  app.get("/users/:id", async (request, response) => {
    useWideEvent().setFields({ user: { id: request.params.id, email: "secret@example.com" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.json({ ok: true });
  });

  app.get("/handled", (_request, response) => {
    useWideEvent().addError(new Error("card declined"));
    response.status(200).json({ ok: false });
  });

  app.get("/fail", () => {
    throw new TypeError("payment failed");
  });

  app.use(createExpressErrorMiddleware());
  app.use((_error, _request, response, _next) => {
    response.status(500).end();
  });

  const server = app.listen(0, () => {
    process.send({ port: server.address().port });
  });

  process.on("message", async (message) => {
    if (message !== "shutdown") {
      return;
    }

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const flushed = await waido.destroy({ timeoutMs: 5_000 });
    await tracerProvider.shutdown();
    await loggerProvider.shutdown();
    process.send({ flushed });
    process.disconnect();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
