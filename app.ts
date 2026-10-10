import express, { Request, Response } from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./src/router.js";
import { createContext } from "./src/context.js";

export const app = express();

const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) ?? ["http://localhost:5173"];

app.use(
  cors({
    origin: trustedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(express.json());

app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

app.get("/", (_request: Request, response: Response) => {
  response.send("Server is Live!");
});
