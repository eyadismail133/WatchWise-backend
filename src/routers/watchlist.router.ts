import { z } from "zod";
import { TRPCError } from "@trpc/server";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";
import { protectedProcedure, router } from "../trpc.js";

const tmdbRefInput = z.object({
  tmdbId: z.number().int().positive(),
  mediaType: z.enum(["movie", "tv"]),
});

const watchlistStatusInput = z.enum(["want_to_watch", "watched"]);

export const watchlistRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          status: watchlistStatusInput.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const items = await prisma.watchlistItem.findMany({
        where: {
          userId: ctx.userId,
          ...(input?.status ? { status: input.status } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });

      const titles = await Promise.all(
        items.map(async (item) => {
          try {
            const detail = await getDetails(
              item.tmdbId,
              item.mediaType as MediaType,
            );
            return { ...item, title: detail };
          } catch {
            return null;
          }
        }),
      );

      return titles.filter(Boolean);
    }),

  getByTitle: protectedProcedure
    .input(tmdbRefInput)
    .query(async ({ ctx, input }) => {
      return prisma.watchlistItem.findUnique({
        where: {
          userId_tmdbId_mediaType: {
            userId: ctx.userId,
            tmdbId: input.tmdbId,
            mediaType: input.mediaType,
          },
        },
      });
    }),

  add: protectedProcedure
    .input(
      tmdbRefInput.extend({
        status: watchlistStatusInput.default("want_to_watch"),
        userRating: z.number().int().min(1).max(5).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.watchlistItem.upsert({
        where: {
          userId_tmdbId_mediaType: {
            userId: ctx.userId,
            tmdbId: input.tmdbId,
            mediaType: input.mediaType,
          },
        },
        create: {
          userId: ctx.userId,
          tmdbId: input.tmdbId,
          mediaType: input.mediaType,
          status: input.status,
          userRating: input.userRating,
        },
        update: {
          status: input.status,
          userRating: input.userRating,
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        status: watchlistStatusInput.optional(),
        userRating: z.number().int().min(1).max(5).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.watchlistItem.findFirst({
        where: { id: input.id, userId: ctx.userId },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Watchlist item not found",
        });
      }
      return prisma.watchlistItem.update({
        where: { id: input.id },
        data: {
          status: input.status,
          userRating: input.userRating,
        },
      });
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.watchlistItem.findFirst({
        where: { id: input.id, userId: ctx.userId },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Watchlist item not found",
        });
      }
      await prisma.watchlistItem.delete({ where: { id: input.id } });
      return { success: true };
    }),
});

export default watchlistRouter;
