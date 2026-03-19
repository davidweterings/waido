import * as Sentry from "@sentry/node";

import { initWaido, useLogger, withWideContext } from "../src/index.js";
import type { WideEvent } from "../src/index.js";

type SentryTagValue = string | number | boolean | undefined;

const SENTRY_TAG_ALLOWLIST: Record<string, (event: WideEvent) => SentryTagValue> = {
  service: (event) => event.service,
  environment: (event) => event.environment,
  name: (event) => event.name,
  kind: (event) => event.kind,
  outcome: (event) => event.outcome,
  status: (event) => event.status,
  error_code: (event) => event.errors[0]?.code,
  error_name: (event) => event.errors[0]?.name,
  sampling_reason: (event) => event.sampling.reason,
};

function toSentryError(event: WideEvent): Error {
  const firstError = event.errors[0];
  if (firstError) {
    const error = new Error(firstError.message);
    error.name = firstError.name;
    if (firstError.stack) {
      error.stack = firstError.stack;
    }
    return error;
  }

  return new Error(`Wide event "${event.name}" ended with outcome=error`);
}

function setAllowedTags(scope: Sentry.Scope, event: WideEvent): void {
  for (const [key, valueFactory] of Object.entries(SENTRY_TAG_ALLOWLIST)) {
    const value = valueFactory(event);
    if (value === undefined || value === "") {
      continue;
    }

    scope.setTag(key, String(value));
  }
}

function createSentryExceptionDrain(): (event: WideEvent) => void {
  return (event) => {
    if (event.outcome !== "error") {
      return;
    }

    Sentry.withScope((scope) => {
      scope.setLevel("error");
      setAllowedTags(scope, event);

      scope.setContext("wide_event", {
        id: event.id,
        status: event.status ? String(event.status) : "n/a",
        durationMs: event.durationMs,
        sampled: event.sampled,
        samplingReason: event.sampling.reason ?? "n/a",
        samplingRule: event.sampling.rule ?? "n/a",
        traceId: event.traceId,
        spanId: event.spanId,
      });

      scope.setContext("wide_event_data", event.data as Record<string, unknown>);

      for (const err of event.errors) {
        scope.setContext("wide_event_error", {
          why: err.why,
          fix: err.fix,
          link: err.link,
        });
      }

      Sentry.captureException(toSentryError(event));
    });
  };
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
});

initWaido({
  service: "payments-api",
  drains: [createSentryExceptionDrain()],
});

const result = await withWideContext(
  {
    name: "checkout",
    kind: "function",
  },
  async () => {
    const log = useLogger();

    try {
      throw new Error("Card declined");
    } catch (error) {
      log.error(
        error,
        {
          orderId: "ord_42",
        },
        {
          code: "PAYMENT_DECLINED",
          why: "Issuer declined the card.",
          fix: "Retry with a different card.",
          link: "https://docs.example.com/payments/errors#payment_declined",
        },
      );

      // Ensure the event is emitted as an error when the function returns successfully.
      await log.emit({
        outcome: "error",
        status: 402,
      });
    }
  },
);

if (result.isErr()) {
  console.error("checkout failed", result.error);
}

await Sentry.flush(2_000);
