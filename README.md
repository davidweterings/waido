# waido

Yet another wide event library.

Inspired by the wide-event approach from `loggingsucks.com`.

Focussed on Express middleware or standalone use via `withWideContext`.

## Install

```bash
npm install waido
```

## Core idea

- Build one mutable wide event during execution.
- Access it anywhere with `useLogger()` via `AsyncLocalStorage` to avoid passing it down forever.
- Emit once at the end (auto by wrappers), with sampler decisions and diagnostics.

## Quick start

```ts
import { initWaido, useLogger, withWideContext } from "waido";

initWaido({
  service: "billing-api",
  drains: [
    async (event) => {
      console.log(JSON.stringify(event));
    },
  ],
});

const run = await withWideContext({ name: "rebuild-cache" }, async () => {
  const log = useLogger();
  log.setFields({ tenantId: "acme" });
  log.setFields({ cache: { phase: "done" } });
});

if (run.isErr()) {
  console.error(run.error);
}
```

## Result-first wrappers (`better-result`)

- `withWideContext()`
- `flushWideEvents()`

## New runtime features

### 1) Lifecycle hooks (`enrich` + `drain`)

```ts
initWaido({
  enrichers: [
    ({ event }) => {
      event.data.deploymentId = process.env.DEPLOYMENT_ID;
    },
  ],
  drains: [
    async (event) => {
      // send to sink
    },
  ],
});
```

### 2) Structured errors (`why`, `fix`, `link`)

```ts
import { createStructuredError } from "waido";

throw createStructuredError({
  message: "Payment failed",
  why: "Card declined by issuer",
  fix: "Retry with another card",
  link: "https://docs.example.com/payments",
});
```

### 5) Include/exclude filters

Express:

```ts
createExpressWideEventMiddleware({
  includePaths: ["/api/**"],
  excludePaths: ["/api/health"],
});
```

### 6) Bounded payload policy

```ts
initWaido({
  payloadPolicy: {
    maxBytes: 32_000,
    overflowStrategy: "truncate", // "truncate" | "drop" | "error"
  },
});
```

### 7) Flush semantics

Manual flush:

```ts
import { flushWideEvents } from "waido";

const flush = await flushWideEvents({ timeoutMs: 10_000 });
if (flush.isErr()) {
  // handle timeout
}
```

### 8) Sampling observability

Sampler can return decision metadata:

```ts
initWaido({
  sampler: (event) => ({
    sampled: event.outcome === "error",
    reason: event.outcome === "error" ? "always_keep_errors" : "non_error_drop",
    rule: "error_only",
  }),
});
```

The emitted event includes:

- `sampled` (boolean)
- `sampling.reason`
- `sampling.rule`

### 9) Trace context helpers

Built-ins:

```ts
import { extractTraceContextFromHeaders, parseTraceparent } from "waido";
```

Express adapter auto-parses `traceparent` / `tracestate` headers.

## Adapters

### Express

```ts
import express from "express";
import { createExpressWideEventMiddleware, initWaido, useLogger } from "waido";

initWaido({ drains: [async (event) => console.log(event)] });

const app = express();
app.use(createExpressWideEventMiddleware());

app.get("/users/:id", (req, res) => {
  const log = useLogger();
  log.setFields({ user: { id: req.params.id } });
  res.json({ ok: true });
});
```

## Redaction and allowlist (userland example)

Redaction/allowlist is intentionally not hardcoded in core.
Use an enricher to apply policy in your app:

```ts
initWaido({
  enrichers: [
    ({ event }) => {
      // apply allowlist + redact before drains
      event.data = redactAndAllowlist(event.data);
    },
  ],
});
```

See: `examples/redaction-allowlist-userland.ts`.

## OpenTelemetry emission example

See: `examples/emit-to-opentelemetry.ts`.

## Sentry exception drain example

See: `examples/sentry-exception-drain.ts`.
The example uses an explicit Sentry tag allowlist so high-cardinality fields stay in context, not tags.

## Releasing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing.

1. Add a changeset to your PR:

   ```bash
   pnpm changeset
   ```

   Select the bump type (patch/minor/major) and describe the change.

2. Merge the PR into `main`. The CI will detect pending changesets and open a "Release new version" PR that bumps the version and updates the changelog.

3. Merge the release PR. CI will publish the new version to npm automatically.
