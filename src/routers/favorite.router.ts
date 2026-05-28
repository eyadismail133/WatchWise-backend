import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";
import { protectedProcedure, router } from "../trpc.js";

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
    return prisma.favorite.upsert({
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
