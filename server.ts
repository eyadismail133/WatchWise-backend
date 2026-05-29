import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./src/router.js";
import { createContext } from "./src/context.js";

const app = express();

const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:5173"];

const corsOptions = {
  origin: trustedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.set("trust proxy", 1);

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

app.all("/api/auth/{*any}", toNodeHandler(auth));

// tRPC endpoint
app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

const port = process.env.PORT || 3000;

app.get("/", (req: Request, res: Response) => {
  res.send("Server is Live!");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
