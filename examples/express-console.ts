import express from "express";
import {
  createConsoleDrain,
  createTailSampler,
  errors,
  initWaido,
  slowerThan,
  useWideEvent,
} from "waido";
import { createExpressErrorMiddleware, createExpressWideEventMiddleware } from "waido/express";

const waido = initWaido({
  service: "payments-api",
  sampler: createTailSampler({ keep: [errors(), slowerThan(2_000)], rate: 1 }),
  drains: [createConsoleDrain({ pretty: true })],
});

const app = express();
app.use(express.json());
app.use(createExpressWideEventMiddleware({ excludePaths: ["/checkout/health"] }));

app.get("/cart", async (req, res) => {
  const event = useWideEvent();

  event.setFields({
    cart: {
      id: "123",
    },
  });

  event.setFields({
    cart: {
      items: req.body?.items?.length ?? 0,
    },
  });

  res.status(200).json({
    ok: true,
  });
});

app.post("/checkout", async (req, res) => {
  const event = useWideEvent();

  event.setFields({
    user: {
      id: req.body.userId,
    },
  });

  event.setFields({
    cart: {
      items: req.body.items?.length ?? 0,
    },
  });

  res.status(201).json({
    ok: true,
  });
});

app.get("/boom", () => {
  throw new Error("Something broke");
});

// Mount this after your routes, so thrown errors reach the event.
app.use(createExpressErrorMiddleware());

const server = app.listen(3000, () => {
  console.log("http://localhost:3000");
});

process.on("SIGTERM", () => {
  server.close(async () => {
    await waido.destroy({ timeoutMs: 10_000 });
  });
});
