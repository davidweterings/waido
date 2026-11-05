import { trace } from "@opentelemetry/api";
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { initWaido, withWideEvent } from "waido";

// This is your application's existing tracing setup. Waido needs no configuration to use it.
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
tracerProvider.register();

const waido = initWaido({ service: "checkout-worker" });

await trace.getTracer("example").startActiveSpan("checkout", async (span) => {
  // These fields land on the span above, and the event carries its trace ID.
  await withWideEvent({ name: "checkout", kind: "job" }, (event) => {
    event.setFields({ order: { id: "ord_111", total: 12_000 } });
  });

  span.end();
});

await waido.destroy();
await tracerProvider.shutdown();
