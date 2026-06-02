import { z } from "zod";
import { TRPCError } from "@trpc/server";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";
import { protectedProcedure, router } from "../trpc.js";
import { recordActivity } from "../services/activity.js";
import { ActivityType } from "../../generated/prisma/index.js";

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
      const item = await prisma.watchlistItem.upsert({
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

      const activityType =
        input.status === "watched" ? ActivityType.marked_watched : ActivityType.added_to_watchlist;

      let titleName: string | undefined;
      let posterPath: string | undefined;
      try {
        const details = await getDetails(input.tmdbId, input.mediaType as MediaType);
        titleName = details.title ?? undefined;
        posterPath = details.poster_path ?? undefined;
      } catch {}

      await recordActivity(ctx.userId, activityType, {
        tmdbId: input.tmdbId,
        mediaType: input.mediaType,
        metadata: {
          ...(input.userRating && { rating: input.userRating }),
          ...(titleName && { titleName }),
          ...(posterPath && { posterPath }),
        },
      });

      return item;
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
      const updated = await prisma.watchlistItem.update({
        where: { id: input.id },
        data: {
          status: input.status,
          userRating: input.userRating,
        },
      });

      if (input.status === "watched" || input.userRating) {
        let titleName: string | undefined;
        let posterPath: string | undefined;
        try {
          const details = await getDetails(existing.tmdbId, existing.mediaType as MediaType);
          titleName = details.title ?? undefined;
          posterPath = details.poster_path ?? undefined;
        } catch {}

        if (input.status === "watched") {
          await recordActivity(ctx.userId, ActivityType.marked_watched, {
            tmdbId: existing.tmdbId,
            mediaType: existing.mediaType,
            metadata: { ...(titleName && { titleName }), ...(posterPath && { posterPath }) },
          });
        } else if (input.userRating) {
          await recordActivity(ctx.userId, ActivityType.rated_title, {
            tmdbId: existing.tmdbId,
            mediaType: existing.mediaType,
            metadata: { rating: input.userRating, ...(titleName && { titleName }), ...(posterPath && { posterPath }) },
          });
        }
      }

      return updated;
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
