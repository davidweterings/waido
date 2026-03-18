import express from "express";

import {
  createConsoleEmitter,
  createExpressWideEventMiddleware,
  initWideEvents,
  useLogger
} from "../src/index.js";

initWideEvents({
  service: "payments-api",
  drains: [createConsoleEmitter({ pretty: true })]
});

const app = express();
app.use(express.json());
app.use(
  createExpressWideEventMiddleware({
    includePaths: ["/checkout/**"],
    excludePaths: ["/checkout/health"]
  })
);

app.post("/checkout", async (req, res) => {
  const log = useLogger();
  if (log.isErr()) {
    res.status(500).json({
      ok: false,
      error: log.error.message
    });
    return;
  }

  log.value.set({
    user: {
      id: req.body.userId
    }
  });

  log.value.set({
    cart: {
      items: req.body.items?.length ?? 0
    }
  });

  res.status(201).json({
    ok: true
  });
});

app.listen(3000, () => {
  console.log("http://localhost:3000");
});
