import { createConsoleDrain, createRedactor, initWaido, useWideEvent, withWideEvent } from "waido";

const ALLOWED_TOP_LEVEL_KEYS = new Set(["http", "request", "user", "order", "tenantId"]);

const waido = initWaido({
  service: "orders-api",
  // An allowlist fits an enricher, since it runs before redaction.
  enrichers: [
    ({ event }) => {
      for (const key of Object.keys(event.data)) {
        if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
          delete event.data[key];
        }
      }
    },
  ],
  redact: createRedactor({
    paths: ["user.email", "request.authorization"],
  }),
  drains: [createConsoleDrain({ pretty: true })],
});

await withWideEvent({ name: "create-order", kind: "function" }, () => {
  useWideEvent().setFields({
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
});

await waido.destroy();
