import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import prisma from "../../lib/prisma.js";

const cursorInput = z.object({
  cursor: z.string().optional(), // "<createdAt ISO>_<id>"
  limit: z.number().min(1).max(50).default(20),
});

function parseCursor(cursor?: string) {
  if (!cursor) return undefined;
  const [iso, idStr] = cursor.split("_");
  return { createdAt: new Date(iso), id: parseInt(idStr, 10) };
}

function buildCursor(createdAt: Date, id: number) {
  return `${createdAt.toISOString()}_${id}`;
}

export const activityRouter = router({
  // A user's own activity timeline (privacy-enforced)
  userActivity: publicProcedure
    .input(z.object({ username: z.string(), ...cursorInput.shape }))
    .query(async ({ input, ctx }) => {
      const { username, cursor, limit } = input;

      const user = await prisma.user.findUnique({
        where: { username: username.toLowerCase() },
        select: { id: true, isActivityPublic: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      const isOwner = ctx.userId === user.id;
      if (!isOwner && !user.isActivityPublic) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This user's activity is private." });
      }

      const parsed = parseCursor(cursor);
      const activities = await prisma.activity.findMany({
        where: {
          userId: user.id,
          ...(parsed && {
            OR: [
              { createdAt: { lt: parsed.createdAt } },
              { createdAt: parsed.createdAt, id: { lt: parsed.id } },
            ],
          }),
        },
        include: {
          user: { select: { id: true, name: true, username: true, image: true, avatar: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });

      const hasMore = activities.length > limit;
      const items = hasMore ? activities.slice(0, limit) : activities;
      const nextCursor = hasMore ? buildCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined;
      return { items, nextCursor };
    }),

  // Following feed — activities from users I follow
  feed: protectedProcedure
    .input(cursorInput)
    .query(async ({ input, ctx }) => {
      const { cursor, limit } = input;

      const followingRows = await prisma.follow.findMany({
        where: { followerId: ctx.userId },
        select: { followingId: true },
      });
      const followingIds = followingRows.map((r) => r.followingId);

      if (followingIds.length === 0) return { items: [], nextCursor: undefined };

      const parsed = parseCursor(cursor);
      const activities = await prisma.activity.findMany({
        where: {
          userId: { in: followingIds },
          ...(parsed && {
            OR: [
              { createdAt: { lt: parsed.createdAt } },
              { createdAt: parsed.createdAt, id: { lt: parsed.id } },
            ],
          }),
        },
        include: {
          user: { select: { id: true, name: true, username: true, image: true, avatar: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });

      const hasMore = activities.length > limit;
      const items = hasMore ? activities.slice(0, limit) : activities;
      const nextCursor = hasMore ? buildCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined;
      return { items, nextCursor };
    }),
});
