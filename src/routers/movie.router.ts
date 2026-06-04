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

import {
  getAiRecommendation,
  getAiTasteProfile,
  type AiTasteResult,
} from "../../services/aiRecommendation.js";

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

  // Feature 1: AI-powered discover assistant
  askAi: protectedProcedure
    .input(z.object({ prompt: z.string().min(3).max(500) }))
    .mutation(async ({ input, ctx }) => {
      // Gather light taste context to help the AI personalise the pick
      const [watchlist, favorites] = await Promise.all([
        prisma.watchlistItem.findMany({
          where: { userId: ctx.userId },
          take: 15,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.favorite.findMany({
          where: { userId: ctx.userId },
          take: 10,
          orderBy: { createdAt: "desc" },
        }),
      ]);

      const genreCounts = new Map<string, number>();
      const watchHistory: string[] = [];

      await Promise.all(
        [...watchlist, ...favorites].map(async (ref) => {
          try {
            const detail = await getDetails(ref.tmdbId, ref.mediaType as MediaType);
            watchHistory.push(detail.title);
            for (const genre of detail.genres) {
              genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
            }
          } catch {
            // ignore
          }
        }),
      );

      const topGenres = [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name);

      const profile = await prisma.tasteProfile.findUnique({
        where: { userId: ctx.userId },
      });
      const topMoods =
        (profile?.favoriteMoods as string[] | null)?.slice(0, 4) ?? [];

      // Ask the AI
      const aiResult = await getAiRecommendation({
        userPrompt: input.prompt,
        topGenres,
        topMoods,
        watchHistory: watchHistory.slice(0, 10),
      });

      // Resolve against TMDB so we always return a real card
      let titleDetail;
      try {
        const searchResults = await searchMulti(aiResult.title);
        const match =
          searchResults.results.find((r) => r.mediaType === aiResult.mediaType) ??
          searchResults.results[0];

        if (match) {
          titleDetail = await getDetails(match.id, match.mediaType as MediaType);
        }
      } catch {
        // ignore search failures
      }

      // Fallback: pick a random trending title
      if (!titleDetail) {
        const fallbackMediaType: MediaType =
          aiResult.mediaType === "tv" ? "tv" : "movie";
        const pick = await getRandomTrendingPick(fallbackMediaType);
        titleDetail = await getDetails(pick.id, fallbackMediaType);
      }

      return {
        title: titleDetail,
        confidence: Math.floor(80 + Math.random() * 15),
        explanation: aiResult.explanation,
        moodTags: titleDetail.genres.slice(0, 3).map((g) => g.toLowerCase()),
        isHiddenGem: (titleDetail.hidden_gem_score ?? 0) > 30,
      };
    }),

  // Feature 2: AI-generated taste profile (cached)
  getAiTasteProfile: protectedProcedure.query(async ({ ctx }) => {
    const CACHE_DAYS = 7;
    const cached = await prisma.tasteProfile.findUnique({
      where: { userId: ctx.userId },
    });

    // Return cache if fresh and has AI scores
    if (cached?.aiSummary && cached.narrativeScore !== null) {
      const age =
        (Date.now() - new Date(cached.updatedAt).getTime()) /
        (1000 * 60 * 60 * 24);
      if (age < CACHE_DAYS) {
        return {
          narrative: cached.narrativeScore ?? 50,
          visual: cached.visualScore ?? 50,
          emotional: cached.emotionalScore ?? 50,
          pacing: cached.pacingScore ?? 50,
          era: cached.eraScore ?? 50,
          breadth: cached.genreBreadthScore ?? 50,
          topGenres: (cached.favoriteGenres as string[] | null) ?? [],
          topMoods: (cached.favoriteMoods as string[] | null) ?? [],
          personality:
            (cached.dislikedPatterns as { personality?: string } | null)
              ?.personality ?? "Cinema Wanderer",
          summary: cached.aiSummary,
        } satisfies AiTasteResult;
      }
    }

    // Build activity context
    const [watchlist, favorites] = await Promise.all([
      prisma.watchlistItem.findMany({
        where: { userId: ctx.userId },
        take: 30,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.favorite.findMany({
        where: { userId: ctx.userId },
        take: 20,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const favoriteSet = new Set(
      favorites.map((f) => `${f.tmdbId}-${f.mediaType}`),
    );

    const activity: {
      title: string;
      genres: string[];
      mediaType: string;
      userRating?: number | null;
      status?: string;
      isFavorite: boolean;
      year?: number | null;
    }[] = [];

    await Promise.all(
      [...watchlist, ...favorites].map(async (ref) => {
        try {
          const detail = await getDetails(
            ref.tmdbId,
            ref.mediaType as MediaType,
          );
          const key = `${ref.tmdbId}-${ref.mediaType}`;
          activity.push({
            title: detail.title,
            genres: detail.genres,
            mediaType: ref.mediaType,
            userRating: "userRating" in ref ? ref.userRating : undefined,
            status: "status" in ref ? (ref.status as string) : undefined,
            isFavorite: favoriteSet.has(key),
            year: detail.releaseYear,
          });
        } catch {
          // ignore
        }
      }),
    );

    if (activity.length === 0) {
      return {
        narrative: 50,
        visual: 50,
        emotional: 50,
        pacing: 50,
        era: 50,
        breadth: 50,
        topGenres: [],
        topMoods: [],
        personality: "Cinema Wanderer",
        summary:
          "Start watching and rating titles to build your taste profile.",
      } satisfies AiTasteResult;
    }

    const result = await getAiTasteProfile(activity);

    // Persist to cache
    await prisma.tasteProfile.upsert({
      where: { userId: ctx.userId },
      create: {
        userId: ctx.userId,
        narrativeScore: result.narrative,
        visualScore: result.visual,
        emotionalScore: result.emotional,
        pacingScore: result.pacing,
        eraScore: result.era,
        genreBreadthScore: result.breadth,
        favoriteGenres: result.topGenres,
        favoriteMoods: result.topMoods,
        aiSummary: result.summary,
        dislikedPatterns: { personality: result.personality },
      },
      update: {
        narrativeScore: result.narrative,
        visualScore: result.visual,
        emotionalScore: result.emotional,
        pacingScore: result.pacing,
        eraScore: result.era,
        genreBreadthScore: result.breadth,
        favoriteGenres: result.topGenres,
        favoriteMoods: result.topMoods,
        aiSummary: result.summary,
        dislikedPatterns: { personality: result.personality },
      },
    });

    return result;
  }),

  // Force-regenerate the AI taste profile (clears cache)
  regenerateTasteProfile: protectedProcedure.mutation(async ({ ctx }) => {
    // Clear the cached AI summary to force recompute on next getAiTasteProfile call
    await prisma.tasteProfile.upsert({
      where: { userId: ctx.userId },
      create: { userId: ctx.userId, aiSummary: null, narrativeScore: null },
      update: { aiSummary: null, narrativeScore: null },
    });

    // Build fresh activity context
    const [watchlist, favorites] = await Promise.all([
      prisma.watchlistItem.findMany({
        where: { userId: ctx.userId },
        take: 30,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.favorite.findMany({
        where: { userId: ctx.userId },
        take: 20,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const favoriteSet = new Set(
      favorites.map((f) => `${f.tmdbId}-${f.mediaType}`),
    );

    const activity: {
      title: string;
      genres: string[];
      mediaType: string;
      userRating?: number | null;
      status?: string;
      isFavorite: boolean;
      year?: number | null;
    }[] = [];

    await Promise.all(
      [...watchlist, ...favorites].map(async (ref) => {
        try {
          const detail = await getDetails(
            ref.tmdbId,
            ref.mediaType as MediaType,
          );
          const key = `${ref.tmdbId}-${ref.mediaType}`;
          activity.push({
            title: detail.title,
            genres: detail.genres,
            mediaType: ref.mediaType,
            userRating: "userRating" in ref ? ref.userRating : undefined,
            status: "status" in ref ? (ref.status as string) : undefined,
            isFavorite: favoriteSet.has(key),
            year: detail.releaseYear,
          });
        } catch {
          // ignore
        }
      }),
    );

    if (activity.length === 0) {
      return {
        narrative: 50,
        visual: 50,
        emotional: 50,
        pacing: 50,
        era: 50,
        breadth: 50,
        topGenres: [],
        topMoods: [],
        personality: "Cinema Wanderer",
        summary:
          "Start watching and rating titles to build your taste profile.",
      } satisfies AiTasteResult;
    }

    const result = await getAiTasteProfile(activity);

    await prisma.tasteProfile.update({
      where: { userId: ctx.userId },
      data: {
        narrativeScore: result.narrative,
        visualScore: result.visual,
        emotionalScore: result.emotional,
        pacingScore: result.pacing,
        eraScore: result.era,
        genreBreadthScore: result.breadth,
        favoriteGenres: result.topGenres,
        favoriteMoods: result.topMoods,
        aiSummary: result.summary,
        dislikedPatterns: { personality: result.personality },
      },
    });

    return result;
  }),
});

export default movieRouter;
