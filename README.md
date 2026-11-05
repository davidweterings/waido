# waido

Wide events for Node.js: one rich event per request, sampled after the work finishes, and sent wherever you want it.

Instead of scattering log lines through your code, you build up one event as a request runs and emit it once at the end. The idea comes from [loggingsucks.com](https://loggingsucks.com/) and Stripe's canonical log lines.

- **One event per unit of work:** read it anywhere with `useWideEvent()`, without passing it around.
- **Tail sampling:** always keep errors and slow requests, and sample the rest.
- **Send events anywhere:** stdout by default, any OTLP backend with one line, or your own drain.
- **Works with your tracing:** if your app already uses OpenTelemetry, events pick up its trace IDs and enrich its spans, with no configuration.
- **Safe by design:** telemetry failures never change what your code returns or throws, and a bad field can't lose an event.
- **No runtime dependencies:** Node.js 22+, with an Express adapter and a standalone wrapper for everything else.

## Install

```bash
npm install waido
```

## Quick start

```ts
import { initWaido, useWideEvent, withWideEvent } from "waido";

const waido = initWaido({ service: "billing-api" });

await withWideEvent({ name: "rebuild-cache" }, async () => {
  const event = useWideEvent();
  event.setFields({ tenant: { id: "acme" } });
  event.setFields({ cache: { entries: 1200 } });
});

await waido.destroy();
```

This writes one JSON line to stdout:

```json
{
  "id": "4d6343e5-af1e-4ff4-b862-c8a9965afd6d",
  "name": "rebuild-cache",
  "kind": "custom",
  "service": "billing-api",
  "startedAt": "2026-11-05T12:48:52.048Z",
  "endedAt": "2026-11-05T12:48:52.049Z",
  "durationMs": 1,
  "outcome": "success",
  "data": { "tenant": { "id": "acme" }, "cache": { "entries": 1200 } },
  "errors": [],
  "payload": { "sizeBytes": 288, "truncated": false, "maxBytes": 65536 },
  "sampling": { "reason": "default_keep", "sampleRate": 1 }
}
```

It's formatted here for reading. `environment` also appears when `NODE_ENV` is set.

`withWideEvent` returns or rethrows exactly what your function does. If you never call `initWaido()`, `useWideEvent()` is a silent no-op, so libraries can use waido without forcing output on an application.

## Express

```ts
import express from "express";
import { initWaido, useWideEvent } from "waido";
import { createExpressErrorMiddleware, createExpressWideEventMiddleware } from "waido/express";

const waido = initWaido({ service: "payments-api" });

const app = express();
app.use(createExpressWideEventMiddleware({ excludePaths: ["/health"] }));

app.get("/users/:id", (req, res) => {
  useWideEvent().setFields({ user: { id: req.params.id } });
  res.json({ ok: true });
});

// Mount this after your routes. Express doesn't let other middleware see thrown errors.
app.use(createExpressErrorMiddleware());

const server = app.listen(3000);

process.on("SIGTERM", () => {
  server.close(async () => {
    await waido.destroy({ timeoutMs: 10_000 });
  });
});
```

Express 4 and 5 are both supported. Each request produces an event like this:

```json
{
  "name": "GET /users/:id",
  "kind": "http",
  "outcome": "success",
  "status": 200,
  "data": {
    "http": {
      "route": "/users/:id",
      "request": { "method": "GET" },
      "response": { "status_code": 200 }
    },
    "url": { "path": "/users/42" },
    "user": { "id": "42" }
  }
}
```

- **Query strings are never captured by default**, because they often contain secrets. Add what you need with `mapData`.
- **Excluded requests capture nothing**, even if they fail. To keep only failures on a noisy route, leave it included and use a sampler rule.
- **Requests with no matching route** are named with just the method, so scanners can't create endless event names.
- **A router mounted on a path with parameters**, such as `/org/:id`, puts the real value in the name, because Express doesn't expose the mount pattern. Use the `name` option on those routes.

### Thrown errors

`createExpressErrorMiddleware()` records errors and passes them to your own error handlers. An error with a `status` or `statusCode` below 500 is usually normal control flow, so it goes in `data.error` and doesn't affect the outcome. This stops a bot hitting missing URLs from making you keep all its requests. Change this with `isFailure`:

```ts
createExpressErrorMiddleware({ isFailure: (error) => !(error instanceof NotFoundError) });
```

## Writing to the event

```ts
const event = useWideEvent();

event.set("plan", "pro");
event.setFields({ user: { id: "u1" } }); // Deep-merges.
event.setFields("user", { tier: "enterprise" });
event.increment("db.queries");
event.append("warnings", "cache miss");
event.time("charge");
event.timeEnd("charge"); // Adds timings.charge in milliseconds.
event.setStatus(402);
event.addError(error, { orderId: "ord_1" }, { why: "Card declined", fix: "Try another card" });
```

Writes after the event has been emitted are ignored, and the first one is reported to `onError`.

Any value is safe to pass. BigInts become strings, circular references become `"[Circular]"`, and values that can't be read become `"[Unserializable]"`.

### Outcome

The first of these that applies decides the event's `outcome`:

1. An explicit `event.setOutcome()`.
2. Any recorded error makes it `error`.
3. An abandoned request makes it `aborted`.
4. A status of 500 or above makes it `error`.
5. Otherwise, `success`.

A 4xx with nothing recorded is a `success`. If you recovered from an error, such as with a successful retry, call `event.setOutcome("success")`.

### Structured errors

```ts
import { createStructuredError } from "waido";

throw createStructuredError({
  message: "Payment failed",
  code: "PAYMENT_DECLINED",
  why: "Card declined by issuer",
  fix: "Retry with another card",
  link: "https://docs.example.com/payments",
});
```

An event keeps its first 10 errors and counts the rest in `errorsDropped`. Messages and stacks are capped at 4 KiB each.

## Tail sampling

The decision is made after the work finishes, so the outcome and duration are known:

```ts
import { createTailSampler, errors, initWaido, slowerThan } from "waido";

initWaido({
  sampler: createTailSampler({
    keep: [errors(), slowerThan(2000), (event) => event.data.user?.tier === "enterprise"],
    rate: 0.05,
  }),
});
```

- **Any matching `keep` rule** retains the event. Everything else is sampled at `rate`.
- **`traceSampled()`** is an optional rule that keeps events from traces already marked as sampled.
- **Decisions follow the trace.** The random part uses OpenTelemetry's consistent sampling algorithm on the trace ID, so services using the same rate keep or drop the same traces.
- **Counts can be corrected.** Each event records `sampling.sampleRate` as a 1-in-N integer: 20 for a 5% rate, and 1 for rule matches. Multiply by it when counting.

Without a sampler, every event is kept. `createRateSampler` and `createNameRateSampler` cover simpler cases, a custom sampler is any synchronous function returning a boolean or decision, and `event.setSamplingDecision()` overrides the sampler for one event. If a sampler throws, the event is kept and the error goes to `onError`.

## Sending events to a backend

`createOtlpDrain` sends kept events to anything that accepts OTLP/HTTP, such as an OpenTelemetry Collector or an observability backend. There's nothing else to install or set up.

```ts
import { createOtlpDrain, initWaido } from "waido";

const waido = initWaido({
  service: "payments-api",
  drains: [
    createOtlpDrain({
      endpoint: "https://collector.example.com:4318",
      headers: { authorization: `Bearer ${process.env.BACKEND_TOKEN}` },
    }),
  ],
});
```

- **Standard settings work.** Without options it reads `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME`. With no endpoint at all, it throws at startup.
- **Events are sent in batches**, when 512 are waiting or after 5 seconds. Call `flush()` or `destroy()` before your process exits, or waiting events are lost.
- **Failed sends are retried** on 429, 502, 503, 504 and network errors, up to 5 times with backoff, honouring `Retry-After`. Other failures drop the batch.
- **Delivery problems are reported.** Dropped batches, partial rejections and a full queue (2048 events by default) all go to `onError`, or to a warning on stderr if you haven't set one.
- **Credentials go in `headers`.** An endpoint containing a username or password, or an invalid header, throws at startup.

Events arrive as log records named `waido.wide_event`, with nested fields flattened to dotted names such as `user.id` and `http.route`. Waido's own fields use the `waido.` prefix:

| Attribute                                            | Meaning                            |
| ---------------------------------------------------- | ---------------------------------- |
| `waido.event.id`, `.name`, `.kind`, `.parent_id`     | Identity                           |
| `waido.outcome`, `waido.duration_ms`, `waido.status` | Result                             |
| `waido.error_count`, `error.type`, `exception.*`     | Errors, with details of the first  |
| `waido.sample_rate`, `waido.sampling.*`              | Multiply counts by the sample rate |

If your backend expects another name for the sample rate, use `createOtlpDrain({ sampleRateAttribute: "..." })`.

The drain sends JSON. The OTLP spec says servers should accept it, not that they must, so a receiver that only takes binary protobuf won't work directly. An OpenTelemetry Collector accepts JSON and can forward to it in any format.

## Working with your tracing

If your app already uses OpenTelemetry tracing, there's nothing to configure. Waido finds it and:

- **Connects events to traces:** `traceId` and `spanId` come from the active span. Without one, a `traceparent` header provides `traceId` and `parentSpanId`.
- **Enriches spans:** fields are copied onto the recording span before sampling, so a dropped event still enriches its span. Each error becomes an exception event, and the status becomes `ERROR` when the outcome is `error`. Turn this off with `initWaido({ enrichSpans: false })`.
- **Stays out of your traces:** waido's own export requests aren't traced.

If your app doesn't use tracing, none of this applies and you don't need to install anything. Waido doesn't create spans of its own.

If several events share a span, only the first writes to it, so a nested scope can't overwrite its parent's fields or mark the whole request as failed. The others are still sent in full by your drains.

### Limitations

- **Bundlers can hide your tracing from waido.** Waido looks for `@opentelemetry/api` when it starts. If a bundler inlines the package, mark it as external, or events won't connect to your traces.
- **Aborted requests** may close their span before waido finalizes, so only the waido event is complete.
- **Attribute limits apply to spans.** SDKs cap them at 128 attributes by default, so very wide events can lose some. Raise `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` if you need more.
- **`error.type` on HTTP server spans** may be replaced by the status code, because HTTP instrumentation writes it last.

## Finalizing an event

Each event passes through these steps, synchronously up to the drains:

```text
enrichers → redaction → size limit → span enrichment → sampler → drains (background)
```

### Enrichers

Enrichers add fields to every event. They must be synchronous, so fetch anything that needs I/O during the request and `event.set()` it.

```ts
initWaido({
  enrichers: [
    ({ event }) => {
      event.data.deployment = { id: process.env.DEPLOYMENT_ID };
    },
  ],
});
```

### Redaction

```ts
import { createRedactor } from "waido";

initWaido({
  redact: createRedactor({ paths: ["user.email", "users.*.email", "headers.*"] }),
});
```

`*` matches one level, including array items. If redaction throws, all fields are removed rather than risk leaking them.

The redactor only covers `data`. It doesn't scan error messages or stacks, so avoid putting secrets in those. See `examples/redaction-allowlist.ts` for an allowlist.

### Size limit

Events are limited to 64 KiB by default. The largest values in `data` are replaced first, so small fields like `http.route` survive, and `payload.truncated` is set. Error fields are preserved, and only lose their stacks if they would exceed the limit by themselves.

```ts
initWaido({ payloadPolicy: { maxBytes: 32_000 } });
```

### Drains

Drains receive kept events. They run in the background, so a slow backend can't slow down or fail your work. `emitTimeoutMs` sets a limit per drain, and failures go to `onError`.

```ts
import { createConsoleDrain, initWaido } from "waido";

initWaido({
  drains: [createConsoleDrain({ pretty: true }), (event) => sendToWarehouse(event)],
  emitTimeoutMs: 2_000,
  onError: (error, context) => console.error(context.stage, error),
});
```

If you don't set `drains`, events go to stdout as JSON. Pass `drains: []` to send them nowhere.

Telemetry failures never reach your code. By default they're written to stderr, at most once a minute for each kind of failure, with a count of what was skipped. Set `onError` to handle them yourself, for example to send them to your own logger. That replaces the warning, so `onError: () => {}` silences it.

A drain is just a function. If yours batches, it can add a `flush` method, which `flush()` and `destroy()` will wait for, and a `start` method to receive a `report` function for failures that happen in the background.

## Nested work

A nested `withWideEvent` emits its own event, sharing the trace and setting `parentId` to the outer event. This suits background work that can outlive the request.

```ts
await withWideEvent({ name: "import-file" }, async () => {
  await withWideEvent({ name: "parse-row" }, async () => {
    // Emits separately, with parentId set to the import-file event.
  });
});
```

## Shutting down

Drains run in the background, so short-lived processes must wait for them before exiting:

```ts
const { completed, pending } = await waido.destroy({ timeoutMs: 10_000 });

if (!completed) {
  console.error(`${pending} wide event operations didn't finish in time`);
}
```

`flush()` and `flushWideEvents()` wait for in-flight work and pending drains. `destroy()` also shuts the runtime down, even if the wait timed out. None of them reject.

Waido has one runtime per process. Calling `initWaido()` again replaces the previous configuration entirely.

## Custom adapters

```ts
import { createWideEvent, runWithWideEvent } from "waido";

const event = createWideEvent({ name: "consume orders", kind: "queue" });

runWithWideEvent(event, () => handleMessage(message));

event.emit({ status: "acked" });
```

`emit()` returns the event if it was kept, or `undefined` if it was dropped, and later calls have no effect. Use `filter` in `initWaido` to skip capturing some work entirely.

## Examples

Run these from `examples/` after `pnpm build`:

- `pnpm express`: Express with tail sampling and error capture.
- `pnpm otlp`: sending events to an OTLP backend. Set `OTLP_ENDPOINT`.
- `pnpm tracing`: events connecting to an app's existing tracing.
- `pnpm redaction`: redaction with an allowlist.
- `pnpm sentry`: sending failed events to Sentry, with high-cardinality fields kept out of tags.

## Releasing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing.

1. Add a changeset to your PR:

   ```bash
   pnpm changeset
   ```

   Select the bump type (patch/minor/major) and describe the change.

2. Merge the PR into `main`. The CI will detect pending changesets and open a "Release new version" PR that bumps the version and updates the changelog.

3. Merge the release PR. CI will publish the new version to npm automatically.
