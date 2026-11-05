import { createOtlpDrain, createTailSampler, errors, initWaido, withWideEvent } from "waido";

// Point this at an OpenTelemetry Collector or any backend that accepts OTLP/HTTP JSON.
// Without an endpoint option it reads OTEL_EXPORTER_OTLP_ENDPOINT.
const waido = initWaido({
  service: "checkout-worker",
  sampler: createTailSampler({ keep: [errors()], rate: 0 }),
  drains: [createOtlpDrain({ endpoint: process.env.OTLP_ENDPOINT ?? "http://localhost:4318" })],
  onError: (error, context) => console.error(`waido ${context.stage}:`, error),
});

// Sampled out, so this isn't sent.
await withWideEvent({ name: "checkout", kind: "job" }, (event) => {
  event.setFields({ order: { id: "ord_111", total: 12_000 } });
});

// Kept by the errors() rule.
await withWideEvent({ name: "refund", kind: "job" }, (event) => {
  event.setFields({ order: { id: "ord_111" } });
  event.addError(new Error("Refund rejected"));
});

// Events are sent in batches, so wait for them before exiting.
const { completed } = await waido.destroy({ timeoutMs: 10_000 });
console.log(completed ? "Events sent" : "Some events didn't finish in time");
