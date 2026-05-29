import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "./prisma.js";
import "dotenv/config";

const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:5173"];

const isProduction = process.env.NODE_ENV === "production";

/** Use the Vite origin in dev so OAuth callbacks and cookies match the proxied client */
const baseURL = (
  process.env.BETTER_AUTH_URL?.trim() ||
  trustedOrigins[0] ||
  "http://localhost:5173"
).replace(/\/$/, "");

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  trustedOrigins,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET!,
  advanced: {
    database: {
      generateId: "serial",
    },
    cookies: {
      session_token: {
        name: "auth_session",
        attributes: {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          path: "/",
        },
      },
    },
  },
});
