import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, rateLimitedProcedure } from "../trpc.js";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";
import { recordActivity } from "../services/activity.js";
import { ActivityType } from "../../generated/prisma/index.js";

const tmdbRef = z.object({
  tmdbId: z.number().int(),
  mediaType: z.enum(["movie", "tv"]),
});

type CommentRow = {
  id: number;
  userId: number;
  tmdbId: number;
  mediaType: string;
  parentId: number | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  user: { id: number; name: string; username: string | null; image: string | null; avatar: string | null };
  replies?: CommentRow[];
};

function buildTree(flat: CommentRow[]): CommentRow[] {
  const map = new Map<number, CommentRow & { replies: CommentRow[] }>();
  flat.forEach((c) => map.set(c.id, { ...c, replies: [] }));

  const roots: CommentRow[] = [];
  flat.forEach((c) => {
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId)!.replies.push(map.get(c.id)!);
    } else {
      roots.push(map.get(c.id)!);
    }
  });
  return roots;
}

export const commentRouter = router({
  // Get threaded comments for a title
  list: publicProcedure.input(tmdbRef).query(async ({ input }) => {
    const flat = await prisma.comment.findMany({
      where: { tmdbId: input.tmdbId, mediaType: input.mediaType },
      include: {
        user: { select: { id: true, name: true, username: true, image: true, avatar: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return buildTree(flat as CommentRow[]);
  }),

  // Post a new comment (or reply)
  add: rateLimitedProcedure
    .input(
      tmdbRef.extend({
        body: z.string().trim().min(1).max(2000),
        parentId: z.number().int().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // If replying, verify parent belongs to same title
      if (input.parentId) {
        const parent = await prisma.comment.findUnique({
          where: { id: input.parentId },
          select: { tmdbId: true, mediaType: true, deletedAt: true },
        });
        if (!parent || parent.tmdbId !== input.tmdbId || parent.mediaType !== input.mediaType) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid parent comment." });
        }
      }

      const comment = await prisma.comment.create({
        data: {
          userId: ctx.userId,
          tmdbId: input.tmdbId,
          mediaType: input.mediaType,
          parentId: input.parentId ?? null,
          body: input.body,
        },
        include: {
          user: { select: { id: true, name: true, username: true, image: true, avatar: true } },
        },
      });

      let titleName: string | undefined;
      let posterPath: string | undefined;
      try {
        const details = await getDetails(input.tmdbId, input.mediaType as MediaType);
        titleName = details.title ?? undefined;
        posterPath = details.poster_path ?? undefined;
      } catch {}
      await recordActivity(ctx.userId, ActivityType.reviewed_title, {
        tmdbId: input.tmdbId,
        mediaType: input.mediaType,
        metadata: { ...(titleName && { titleName }), ...(posterPath && { posterPath }) },
      });

      return comment;
    }),

  // Edit own comment
  update: rateLimitedProcedure
    .input(z.object({ id: z.number().int(), body: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      const existing = await prisma.comment.findUnique({
        where: { id: input.id },
        select: { userId: true, deletedAt: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.userId !== ctx.userId) throw new TRPCError({ code: "FORBIDDEN" });
      if (existing.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit a deleted comment." });

      return prisma.comment.update({
        where: { id: input.id },
        data: { body: input.body },
        include: {
          user: { select: { id: true, name: true, username: true, image: true, avatar: true } },
        },
      });
    }),

  // Soft-delete own comment
  remove: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await prisma.comment.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.userId !== ctx.userId) throw new TRPCError({ code: "FORBIDDEN" });

      await prisma.comment.update({
        where: { id: input.id },
        data: { deletedAt: new Date(), body: "[deleted]" },
      });
      return { ok: true };
    }),
});
