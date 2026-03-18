# waido

ESM-only wide event library for Node.js (`>=22`) focused on context lifecycle, not logging opinionation.

Inspired by the wide-event approach from `loggingsucks.com` and `evlog`, with adapters for:

- Express middleware
- cron jobs
- serverless/message handlers (Service Bus style)

## Install

```bash
npm install waido
```

## Core idea

- Build one mutable wide event during execution.
- Access it anywhere with `useLogger()` via `AsyncLocalStorage`.
- Emit once at the end (auto by wrappers), with sampler decisions and diagnostics.
- All core APIs are no-throw and return `Result` (`better-result`).

## Quick start

```ts
import { initWideEvents, useLogger, withWideEvent } from "waido";

initWideEvents({
  service: "billing-api",
  drains: [
    async (event) => {
      console.log(JSON.stringify(event));
    }
  ]
});

const run = await withWideEvent(
  { name: "rebuild-cache", kind: "function" },
  async () => {
    const log = useLogger();
    if (log.isErr()) return;

    log.value.set({ tenantId: "acme" });
    log.value.set({ cache: { phase: "done" } });
  }
);

if (run.isErr()) {
  console.error(run.error);
}
```

## Result-first API (`better-result`)

No throwing wrappers are exposed in the public API.

- `useLogger()`
- `withWideEvent()`
- `flushWideEvents()`
- `withCronWideEvent()`
- `runCronWideEvent()`
- `withMessageWideEvent()`
- `withServerlessWideEvent()`

## New runtime features

### 1) Lifecycle hooks (`enrich` + `drain`)

```ts
initWideEvents({
  enrichers: [
    ({ event }) => {
      event.data.deploymentId = process.env.DEPLOYMENT_ID;
    }
  ],
  drains: [
    async (event) => {
      // send to sink
    }
  ]
});
```

### 2) Structured errors (`why`, `fix`, `link`)

```ts
import { createStructuredError } from "waido";

throw createStructuredError({
  message: "Payment failed",
  why: "Card declined by issuer",
  fix: "Retry with another card",
  link: "https://docs.example.com/payments"
});
```

### 5) Include/exclude filters

Express:

```ts
createExpressWideEventMiddleware({
  includePaths: ["/api/**"],
  excludePaths: ["/api/health"]
});
```

Cron/serverless wrappers:

```ts
withCronWideEvent("nightly-sync", handler, {
  excludeNames: ["health-*"]
});
```

### 6) Bounded payload policy

```ts
initWideEvents({
  payloadPolicy: {
    maxBytes: 32_000,
    overflowStrategy: "truncate" // "truncate" | "drop" | "error"
  }
});
```

### 7) Flush semantics

Serverless wrappers call `flushWideEvents()` before returning (default `flushAfterCompletion: true`).

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
initWideEvents({
  sampler: (event) => ({
    sampled: event.outcome === "error",
    reason: event.outcome === "error" ? "always_keep_errors" : "non_error_drop",
    rule: "error_only"
  })
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
Message adapter auto-parses trace data from common message metadata (`headers`, `applicationProperties`, `properties`).

## Adapters

### Express

```ts
import express from "express";
import { createExpressWideEventMiddleware, initWideEvents, useLogger } from "waido";

initWideEvents({ drains: [async (event) => console.log(event)] });

const app = express();
app.use(createExpressWideEventMiddleware());

app.get("/users/:id", (req, res) => {
  const log = useLogger();
  if (log.isOk()) {
    log.value.set({ user: { id: req.params.id } });
  }
  res.json({ ok: true });
});
```

### Cron

```ts
import { useLogger, withCronWideEvent } from "waido";

const job = withCronWideEvent("nightly-sync", async () => {
  const log = useLogger();
  if (log.isErr()) return;
  log.value.set({ stage: "syncing" });
});

const result = await job();
if (result.isErr()) {
  console.error(result.error);
}
```

### Serverless / message

```ts
import { useLogger, withMessageWideEvent } from "waido";

const handler = withMessageWideEvent(async (message: { messageId: string }) => {
  const log = useLogger();
  if (log.isErr()) return;
  log.value.set({ messageId: message.messageId });
});

const result = await handler({ messageId: "m1" }, {});
if (result.isErr()) {
  console.error(result.error);
}
```

## Redaction and allowlist (userland example)

Redaction/allowlist is intentionally not hardcoded in core.
Use an enricher to apply policy in your app:

```ts
initWideEvents({
  enrichers: [
    ({ event }) => {
      // apply allowlist + redact before drains
      event.data = redactAndAllowlist(event.data);
    }
  ]
});
```

See: `examples/redaction-allowlist-userland.ts`.

## OpenTelemetry emission example

See: `examples/emit-to-opentelemetry.ts`.

## Internal `#src/*` imports

The package uses import maps for cleaner internal imports:

```json
{
  "imports": {
    "#src/*": {
      "types": "./src/*",
      "default": "./dist/*"
    }
  }
}
```

## npm publishing pipeline

- CI: `.github/workflows/ci.yml`
- Publish: `.github/workflows/publish.yml`
- Both workflows use hard-pinned action SHAs (managed with `pinact` and `.pinact.yaml`).
- Publish uses npm Trusted Publishing (OIDC), no `NPM_TOKEN` secret.
- Publish command is `npm publish --access public --provenance`.
- Workflow upgrades npm to `^11.5.1` (required for trusted publishing).

Trusted publishing setup on npm:

1. On npmjs.com, open your package settings.
2. Configure `Trusted publishing` for `GitHub Actions` with:
   - your GitHub org/user
   - repository name
   - workflow filename: `publish.yml` in `.github/workflows`
3. Keep GitHub workflow permission `id-token: write` enabled (already set).
