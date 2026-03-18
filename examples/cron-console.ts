import {
  createConsoleEmitter,
  createRateSampler,
  initWideEvents,
  useLogger,
  withCronWideEvent
} from "../src/index.js";

initWideEvents({
  service: "batch-worker",
  sampler: createRateSampler(0.25),
  drains: [createConsoleEmitter({ pretty: true })],
  payloadPolicy: {
    maxBytes: 2048,
    overflowStrategy: "truncate"
  }
});

const nightlyJob = withCronWideEvent(
  "nightly-reconciliation",
  async () => {
    const log = useLogger();
    if (log.isErr()) {
      return;
    }

    log.value.set({
      job: {
        phase: "load"
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    log.value.set({
      job: {
        phase: "apply"
      },
      records: 931
    });
  },
  {
    excludeNames: ["nightly-healthcheck"]
  }
);

const run = await nightlyJob();
if (run.isErr()) {
  console.error("nightly job failed", run.error);
}
