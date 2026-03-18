import {
  createConsoleEmitter,
  createWideEventLogger,
  initWideEvents,
  runWithLoggerContext,
  useLogger,
  withServerlessWideEvent
} from "../src/index.js";

initWideEvents({
  service: "worker",
  drains: [
    async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      createConsoleEmitter({ pretty: true })(event);
    }
  ]
});

const handler = withServerlessWideEvent("process-batch", async () => {
  const log = useLogger();
  if (log.isOk()) {
    log.value.set({
      step: "main-handler"
    });
  }

  const detachedLogger = createWideEventLogger({
    name: "detached-side-effect"
  });

  runWithLoggerContext(detachedLogger, () => {
    const detached = useLogger();
    if (detached.isOk()) {
      detached.value.set({
        source: "detached"
      });
    }
    void detachedLogger.emit();
  });
});

const result = await handler();
if (result.isErr()) {
  console.error("handler failed", result.error);
}
