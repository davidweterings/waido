---
"waido": minor
---

Rework waido around tail sampling and OpenTelemetry. This release has breaking changes.

**Added**

- `createTailSampler` with `errors()`, `slowerThan()` and `traceSampled()` keep rules. Sampling is derived from the trace ID, and events record a 1-in-N `sampling.sampleRate`.
- `waido/otel`: `otel()` takes IDs from the active span, copies fields onto it, and exports kept events as log records.
- `createExpressErrorMiddleware` from `waido/express`, so thrown errors reach the event.
- `createRedactor` and a `redact` option.
- Nested scopes set `parentId`. Events go to stdout as JSON when no drains are configured.

**Fixed**

- A handled error no longer ends up with `outcome: "success"`.
- Express events are named from the route, and query strings are no longer captured.
- `spanId` no longer reports the caller's span from `traceparent`; that is now `parentSpanId`.
- BigInt and circular fields no longer lose the event or fail the work.
- `setFields` can no longer pollute `Object.prototype` through a `__proto__` key in untrusted input.
- Oversized error events are kept, and telemetry failures can no longer fail the work.

**Breaking**

- `withWideContext` returns or rethrows what the work does, and `better-result` is removed. `flush()` and `destroy()` resolve to `{ completed, pending }` and never reject.
- Enrichers and samplers must be synchronous. `log.emit()` is synchronous and returns the event, or `undefined` if it was dropped. Drains run in the background.
- `initWaido` replaces the previous configuration. Invalid configuration throws at startup.
- Excluded requests get a no-op logger and emit nothing, even on failure. `filter` returns a boolean.
- Payload policy always truncates, with a 64 KiB default. The `drop` and `error` strategies are gone.
- The Express adapter moves to `waido/express`, and the dead `waido/cron` and `waido/serverless` exports are removed.
- Event fields change: `sampled`, `traceparent`, `tracestate` and `traceSource` are removed, and `payload` is now `{ sizeBytes, truncated, maxBytes }`. Express fields follow OpenTelemetry names (`http.route`, `http.request.method`, `http.response.status_code`, `url.path`).
- Removed: `emitters` and their aliases, `set*`/`add*` runtime functions, `composeSamplers`, `*Result` samplers, `resolveIncludeExcludeDecision`, and `createConsoleEmitter` (now `createConsoleDrain`). `onEnricherError` and `onDrainError` are now `onError`.
