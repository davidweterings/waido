import express from "express";

import {
  createConsoleEmitter,
  createExpressWideEventMiddleware,
  initWaido,
  useLogger,
} from "../src/index.js";

initWaido({
  service: "payments-api",
  drains: [createConsoleEmitter({ pretty: true })],
});

const app = express();
app.use(express.json());
app.use(
  createExpressWideEventMiddleware({
    includePaths: ["/checkout/**"],
    excludePaths: ["/checkout/health"],
  }),
);

app.post("/checkout", async (req, res) => {
  const log = useLogger();

  log.setFields({
    user: {
      id: req.body.userId,
    },
  });

  log.setFields({
    cart: {
      items: req.body.items?.length ?? 0,
    },
  });

  res.status(201).json({
    ok: true,
  });
});

app.listen(3000, () => {
  console.log("http://localhost:3000");
});
