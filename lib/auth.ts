import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "./prisma.js";
import "dotenv/config";

const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:5173"];

const isProduction = process.env.NODE_ENV === "production";

// FIX: Separate backend baseURL from frontend trustedOrigins completely.
const baseURL = process.env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");

// Safety guard: Crash early during deployment if you forgot to set it on your server host
if (isProduction && !baseURL) {
  throw new Error(
    "❌ CRITICAL DEPLOYMENT ERROR: BETTER_AUTH_URL environment variable is missing on the backend server!",
  );
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  trustedOrigins, // This stays as your Frontend URL(s)
  baseURL: baseURL,
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
