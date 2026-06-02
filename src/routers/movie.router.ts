import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

import prisma from "../../lib/prisma.js";

import {
  discoverMovies,
  discoverTv,
  getDetails,
  getImages,
  getRandomTrendingPick,
  getSimilar,
  getTopRated,
  getUpComing,
  getTrending,
  searchMulti,
  type MediaType,
} from "../../services/tmdb.js";

const discoverInput = z.object({
  page: z.number().int().min(1).max(500).optional(),
  sort_by: z.string().optional(),
  with_genres: z.string().optional(),
  year: z.number().int().optional(),
});

const mediaTypeInput = z.enum(["movie", "tv"]);

const timeWindowInput = z.enum(["day", "week"]);

export const movieRouter = router({
  discoverMovie: publicProcedure
    .input(discoverInput.optional())
    .query(({ input }) => discoverMovies(input ?? {})),

  discoverTv: publicProcedure
    .input(discoverInput.optional())
    .query(({ input }) => discoverTv(input ?? {})),

  details: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        mediaType: mediaTypeInput,
      }),
    )
    .query(({ input }) => getDetails(input.id, input.mediaType)),

  images: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        mediaType: mediaTypeInput,
      }),
    )
    .query(({ input }) => getImages(input.id, input.mediaType)),

  trending: publicProcedure
    .input(
      z
        .object({
          timeWindow: timeWindowInput.optional(),
        })
        .optional(),
    )
    .query(({ input }) => getTrending(input?.timeWindow ?? "week")),

  topRated: publicProcedure
    .input(
      z.object({
        mediaType: mediaTypeInput.default("movie"),
        page: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) => getTopRated(input.mediaType, input.page ?? 1)),

  upComing: publicProcedure
    .input(
      z.object({
        mediaType: mediaTypeInput.default("movie"),
        page: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) => getUpComing(input.mediaType, input.page ?? 1)),

  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1),
        page: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) => searchMulti(input.query, input.page ?? 1)),

  similar: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        mediaType: mediaTypeInput,
        page: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) =>
      getSimilar(input.id, input.mediaType, input.page ?? 1),
    ),

  surprise: protectedProcedure
    .input(
      z
        .object({
          mediaType: mediaTypeInput.optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const mediaType: MediaType = input?.mediaType ?? "movie";

      const pick = await getRandomTrendingPick(mediaType);

      const detail = await getDetails(pick.id, mediaType);

      return {
        title: detail,

        confidence: Math.floor(75 + Math.random() * 20),

        explanation: detail.description,

        moodTags: detail.genres.slice(0, 3).map((g) => g.toLowerCase()),

        isHiddenGem: (detail.hidden_gem_score ?? 0) > 30,
      };
    }),

  getTasteProfile: protectedProcedure.query(async ({ ctx }) => {
    const profile = await prisma.tasteProfile.findUnique({
      where: {
        userId: ctx.userId,
      },
    });

    return profile;
  }),

  getTasteSummary: protectedProcedure.query(async ({ ctx }) => {
    const [watchlist, favorites] = await Promise.all([
      prisma.watchlistItem.findMany({
        where: {
          userId: ctx.userId,
        },
        take: 20,
        orderBy: {
          updatedAt: "desc",
        },
      }),

      prisma.favorite.findMany({
        where: {
          userId: ctx.userId,
        },
        take: 20,
        orderBy: {
          createdAt: "desc",
        },
      }),
    ]);

    const refs = [...watchlist, ...favorites];

    const genreCounts = new Map<string, number>();

    await Promise.all(
      refs.map(async (ref) => {
        try {
          const detail = await getDetails(
            ref.tmdbId,
            ref.mediaType as MediaType,
          );

          for (const genre of detail.genres) {
            genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
          }
        } catch {
          // ignore failed TMDB requests
        }
      }),
    );

    const topGenres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const profile = await prisma.tasteProfile.findUnique({
      where: {
        userId: ctx.userId,
      },
    });

    const topMoods = (profile?.favoriteMoods as string[] | null)?.slice(
      0,
      6,
    ) ?? ["thought-provoking", "emotional", "suspenseful"];

    const summary =
      profile?.aiSummary ??
      (topGenres.length > 0
        ? `You gravitate toward ${topGenres
            .slice(0, 3)
            .join(
              ", ",
            )}. WatchWise will keep surfacing titles that match that taste.`
        : "Rate and save titles to build your taste profile. The more you interact, the sharper your recommendations become.");

    return {
      topGenres,
      topMoods,
      summary,
    };
  }),
});

export default movieRouter;
