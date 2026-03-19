import { context, trace } from "@opentelemetry/api";

import { initWaido, withWideContext } from "../src/index.js";
import type { WideEvent } from "../src/index.js";

function createOpenTelemetryEmitter(): (event: WideEvent) => void {
  return (event) => {
    const span = trace.getSpan(context.active());

    if (!span) {
      return;
    }

    span.addEvent("wide_event", {
      "wide_event.id": event.id,
      "wide_event.name": event.name,
      "wide_event.kind": event.kind,
      "wide_event.outcome": event.outcome,
      "wide_event.status": event.status ? String(event.status) : "n/a",
      "wide_event.duration_ms": event.durationMs,
    });
  };
}

initWaido({
  service: "otel-demo",
  drains: [createOpenTelemetryEmitter()],
});

const result = await withWideContext(
  {
    name: "checkout",
    kind: "function",
  },
  async (log) => {
    log.setFields({
      orderId: "ord_111",
      total: 12000,
    });
  },
);

if (result.isErr()) {
  console.error("wide event failed", result.error);
}
