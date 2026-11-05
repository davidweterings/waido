// A real application with its own tracing: real SDK, real auto-instrumentation, real span exporter.
// Runs as its own process because instrumentation must patch modules before they load.
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");

const endpoint = process.env.OTLP_ENDPOINT;

const tracerProvider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "e2e-app" }),
  spanProcessors: [
    new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
  ],
});
tracerProvider.register();

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new UndiciInstrumentation(),
  ],
});

const express = require("express");

async function main() {
  // Note what's absent: waido has no OpenTelemetry configuration of any kind.
  const { createOtlpDrain, createRedactor, createTailSampler, errors, initWaido, useWideEvent } =
    await import("waido");
  const { createExpressErrorMiddleware, createExpressWideEventMiddleware } =
    await import("waido/express");

  const waido = initWaido({
    service: "e2e-app",
    environment: "e2e",
    // Successes are dropped, so only errors should arrive as log records.
    sampler: createTailSampler({ keep: [errors()], rate: 0 }),
    redact: createRedactor({ paths: ["user.email"] }),
    drains: [createOtlpDrain({ endpoint })],
  });

  const app = express();
  app.use(createExpressWideEventMiddleware());

  app.get("/users/:id", async (request, response) => {
    useWideEvent().setFields({ user: { id: request.params.id, email: "secret@example.com" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.json({ ok: true });
  });

  // An ordinary fetch from the app, proving fetch instrumentation is active.
  app.get("/outbound", async (_request, response) => {
    await fetch(`${endpoint}/outbound-target`);
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
    process.send({ flushed });
    process.disconnect();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
