import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure, rateLimitedProcedure } from "../trpc.js";
import prisma from "../../lib/prisma.js";
import { recordActivity } from "../services/activity.js";
import { ActivityType } from "../../generated/prisma/index.js";

export const socialRouter = router({
  follow: rateLimitedProcedure
    .input(z.object({ userId: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot follow yourself." });
      }
      const target = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, name: true, username: true },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      try {
        await prisma.follow.create({
          data: { followerId: ctx.userId, followingId: input.userId },
        });
      } catch (err: any) {
        if (err?.code === "P2002") return { ok: true }; // already following — idempotent
        throw err;
      }

      await recordActivity(ctx.userId, ActivityType.followed_user, {
        metadata: {
          targetUserId: input.userId,
          targetName: target.name,
          targetUsername: target.username,
        },
      });
      return { ok: true };
    }),

  unfollow: protectedProcedure
    .input(z.object({ userId: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      await prisma.follow.deleteMany({
        where: { followerId: ctx.userId, followingId: input.userId },
      });
      return { ok: true };
    }),

  isFollowing: protectedProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const row = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: ctx.userId, followingId: input.userId } },
        select: { id: true },
      });
      return { isFollowing: !!row };
    }),

  followCounts: publicProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input }) => {
      const [followers, following] = await Promise.all([
        prisma.follow.count({ where: { followingId: input.userId } }),
        prisma.follow.count({ where: { followerId: input.userId } }),
      ]);
      return { followers, following };
    }),

  listFollowers: publicProcedure
    .input(z.object({ userId: z.number().int(), cursor: z.number().optional(), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const { userId, cursor, limit } = input;
      const rows = await prisma.follow.findMany({
        where: { followingId: userId },
        include: {
          follower: {
            select: { id: true, name: true, username: true, image: true, avatar: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items: items.map((r) => r.follower), nextCursor: hasMore ? items[items.length - 1].id : undefined };
    }),

  listFollowing: publicProcedure
    .input(z.object({ userId: z.number().int(), cursor: z.number().optional(), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const { userId, cursor, limit } = input;
      const rows = await prisma.follow.findMany({
        where: { followerId: userId },
        include: {
          following: {
            select: { id: true, name: true, username: true, image: true, avatar: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items: items.map((r) => r.following), nextCursor: hasMore ? items[items.length - 1].id : undefined };
    }),
});
