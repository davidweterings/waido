import {
  createConsoleEmitter,
  initWideEvents,
  useLogger,
  withMessageWideEvent
} from "../src/index.js";

type ServiceBusMessage = {
  messageId: string;
  subject: string;
  body: {
    orderId: string;
    tenantId: string;
  };
};

initWideEvents({
  service: "servicebus-consumer",
  drains: [createConsoleEmitter({ pretty: true })]
});

const handleOrderCreated = withMessageWideEvent(
  async (message: ServiceBusMessage) => {
    const log = useLogger();
    if (log.isErr()) {
      return;
    }

    log.value.set({
      tenant: message.body.tenantId,
      order: {
        id: message.body.orderId
      }
    });
  },
  {
    name: (message) => `servicebus:${message.subject}`,
    includeNames: ["servicebus:orders.*"]
  }
);

const result = await handleOrderCreated(
  {
    messageId: "4e89f911",
    subject: "orders.created",
    body: {
      orderId: "ord_42",
      tenantId: "acme"
    }
  },
  {}
);

if (result.isErr()) {
  console.error("message failed", result.error);
}
