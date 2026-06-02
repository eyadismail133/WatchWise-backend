import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

export async function createContext({ req }: CreateExpressContextOptions) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  const userId = session?.user?.id ? Number(session.user.id) : null;

  return {
    session,
    user: session?.user ?? null,
    userId: Number.isFinite(userId) ? userId : null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
