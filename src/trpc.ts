import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

// In-memory rate limiter: 30 writes/min per user (swap for Redis in production)
const rateLimitMap = new Map<number, { count: number; resetAt: number }>();

export const rateLimitedProcedure = protectedProcedure.use(({ ctx, next }) => {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 30;

  const entry = rateLimitMap.get(ctx.userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ctx.userId, { count: 1, resetAt: now + windowMs });
  } else {
    if (entry.count >= limit) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests — slow down.",
      });
    }
    entry.count++;
  }

  return next();
});
