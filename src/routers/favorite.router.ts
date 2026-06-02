import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";
import { protectedProcedure, router } from "../trpc.js";
import { recordActivity } from "../services/activity.js";
import { ActivityType } from "../../generated/prisma/index.js";

const tmdbRefInput = z.object({
  tmdbId: z.number().int().positive(),
  mediaType: z.enum(["movie", "tv"]),
});

export const favoriteRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const items = await prisma.favorite.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
    });

    const titles = await Promise.all(
      items.map(async (item: (typeof items)[number]) => {
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

  isFavorite: protectedProcedure.input(tmdbRefInput).query(async ({ ctx, input }) => {
    const item = await prisma.favorite.findUnique({
      where: {
        userId_tmdbId_mediaType: {
          userId: ctx.userId,
          tmdbId: input.tmdbId,
          mediaType: input.mediaType,
        },
      },
    });
    return { isFavorite: Boolean(item) };
  }),

  add: protectedProcedure.input(tmdbRefInput).mutation(async ({ ctx, input }) => {
    const item = await prisma.favorite.upsert({
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
      },
      update: {},
    });

    let titleName: string | undefined;
    let posterPath: string | undefined;
    try {
      const details = await getDetails(input.tmdbId, input.mediaType as MediaType);
      titleName = details.title ?? undefined;
      posterPath = details.poster_path ?? undefined;
    } catch {}

    await recordActivity(ctx.userId, ActivityType.added_to_favorites, {
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      metadata: { ...(titleName && { titleName }), ...(posterPath && { posterPath }) },
    });

    return item;
  }),

  remove: protectedProcedure.input(tmdbRefInput).mutation(async ({ ctx, input }) => {
    await prisma.favorite.deleteMany({
      where: {
        userId: ctx.userId,
        tmdbId: input.tmdbId,
        mediaType: input.mediaType,
      },
    });
    return { success: true };
  }),
});

export default favoriteRouter;
