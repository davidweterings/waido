import { createConsoleEmitter, initWaido, useLogger, withWideContext } from "../src/index.js";
import type { WideEventData } from "../src/index.js";

const ALLOWED_TOP_LEVEL_KEYS = new Set(["request", "user", "order", "tenantId"]);
const REDACTED_KEYS = new Set(["email", "phone", "ssn", "authorization", "token"]);

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = redactValue(childValue);
  }

  return output;
}

function allowlistTopLevel(data: WideEventData): WideEventData {
  const output: WideEventData = {};

  for (const [key, value] of Object.entries(data)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      output[key] = value;
    }
  }

  return output;
}

initWaido({
  service: "orders-api",
  enrichers: [
    ({ event }) => {
      const allowlisted = allowlistTopLevel(event.data);
      event.data = redactValue(allowlisted) as WideEventData;
    },
  ],
  drains: [createConsoleEmitter({ pretty: true })],
});

const result = await withWideContext(
  {
    name: "create-order",
    kind: "function",
  },
  async () => {
    const log = useLogger();
    log.setFields({
      tenantId: "acme",
      user: {
        id: "u_42",
        email: "john@acme.dev",
      },
      request: {
        ip: "1.2.3.4",
        authorization: "Bearer secret-token",
      },
      debugOnly: {
        sql: "select * from orders",
      },
    });
  },
);

if (result.isErr()) {
  console.error("create-order failed", result.error);
}
