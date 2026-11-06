import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

import prisma from "../../lib/prisma.js";

import {
  discoverAdvanced,
  discoverMovies,
  discoverTv,
  browseBy,
  getCollection,
  getEpisodeRatings,
  getReleaseCalendar,
  getDetails,
  getFullDetails,
  getGenres,
  getList,
  getPerson,
  getProviderCatalog,
  getReviews,
  getSeason,
  getTrendingPeople,
  searchAll,
  searchByMedia,
  searchPeople,
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

const regionInput = z
  .string()
  .regex(/^[A-Z]{2}$/, "Region must be an ISO 3166-1 alpha-2 code")
  .optional();

const pageInput = z.number().int().min(1).max(500).optional();
const idInput = z.number().int().positive();
const yearInput = z.number().int().min(1870).max(2100);

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
        region: regionInput,
      }),
    )
    .query(({ input }) => getFullDetails(input.id, input.mediaType, input.region)),

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
          mediaType: z.enum(["all", "movie", "tv"]).optional(),
          page: pageInput,
        })
        .optional(),
    )
    .query(({ input }) =>
      getTrending(input?.timeWindow ?? "week", input?.mediaType ?? "all", input?.page ?? 1),
    ),

  // Curated TMDB lists: popular, top rated, now playing, upcoming, airing today, on the air
  list: publicProcedure
    .input(
      z.object({
        mediaType: mediaTypeInput,
        category: z.enum([
          "popular",
          "top_rated",
          "now_playing",
          "upcoming",
          "airing_today",
          "on_the_air",
        ]),
        page: pageInput,
      }),
    )
    .query(({ input }) => getList(input.mediaType, input.category, input.page ?? 1)),

  genres: publicProcedure
    .input(z.object({ mediaType: mediaTypeInput }))
    .query(({ input }) => getGenres(input.mediaType)),

  providers: publicProcedure
    .input(z.object({ mediaType: mediaTypeInput, region: regionInput }))
    .query(({ input }) => getProviderCatalog(input.mediaType, input.region ?? "US")),

  // Full-featured discover with genre / year / rating / runtime / language / provider filters
  discoverAdvanced: publicProcedure
    .input(
      z
        .object({
          mediaType: mediaTypeInput,
          page: pageInput,
          sort: z
            .enum(["popularity", "rating", "newest", "oldest", "votes", "revenue", "title"])
            .optional(),
          genres: z.array(idInput).max(10).optional(),
          excludeGenres: z.array(idInput).max(10).optional(),
          yearFrom: yearInput.optional(),
          yearTo: yearInput.optional(),
          ratingMin: z.number().min(0).max(10).optional(),
          voteCountMin: z.number().int().min(0).max(100000).optional(),
          runtimeMin: z.number().int().min(0).max(600).optional(),
          runtimeMax: z.number().int().min(0).max(600).optional(),
          language: z
            .string()
            .regex(/^[a-z]{2}$/, "Language must be an ISO 639-1 code")
            .optional(),
          providers: z.array(idInput).max(10).optional(),
          region: regionInput,
          keywords: z.array(idInput).max(10).optional(),
          withPeople: z.array(idInput).max(5).optional(),
        })
        .refine(
          (v) => !v.yearFrom || !v.yearTo || v.yearFrom <= v.yearTo,
          { message: "yearFrom must be before yearTo" },
        )
        .refine(
          (v) => v.runtimeMin === undefined || v.runtimeMax === undefined || v.runtimeMin <= v.runtimeMax,
          { message: "runtimeMin must be at most runtimeMax" },
        ),
    )
    .query(({ input }) => discoverAdvanced(input)),

  releaseCalendar: publicProcedure
    .input(
      z
        .object({
          mediaType: mediaTypeInput,
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          region: regionInput,
          page: pageInput,
        })
        .refine((v) => v.from <= v.to, { message: "from must be before to" })
        .refine(
          (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62,
          { message: "Range is limited to about two months" },
        ),
    )
    .query(({ input }) => getReleaseCalendar(input)),

  episodeRatings: publicProcedure
    .input(z.object({ tvId: idInput }))
    .query(({ input }) => getEpisodeRatings(input.tvId)),

  browse: publicProcedure
    .input(
      z.object({
        kind: z.enum(["keyword", "company", "network"]),
        id: idInput,
        mediaType: mediaTypeInput.default("movie"),
        page: pageInput,
        sort: z.enum(["popularity", "rating", "newest", "votes"]).optional(),
      }),
    )
    .query(({ input }) => browseBy(input)),

  person: publicProcedure
    .input(z.object({ id: idInput }))
    .query(({ input }) => getPerson(input.id)),

  trendingPeople: publicProcedure
    .input(
      z
        .object({ timeWindow: timeWindowInput.optional(), page: pageInput })
        .optional(),
    )
    .query(({ input }) => getTrendingPeople(input?.timeWindow ?? "week", input?.page ?? 1)),

  season: publicProcedure
    .input(
      z.object({
        tvId: idInput,
        seasonNumber: z.number().int().min(0).max(500),
      }),
    )
    .query(({ input }) => getSeason(input.tvId, input.seasonNumber)),

  collection: publicProcedure
    .input(z.object({ id: idInput }))
    .query(({ input }) => getCollection(input.id)),

  reviews: publicProcedure
    .input(z.object({ id: idInput, mediaType: mediaTypeInput, page: pageInput }))
    .query(({ input }) => getReviews(input.id, input.mediaType, input.page ?? 1)),

  // Titles + people in one request
  searchAll: publicProcedure
    .input(z.object({ query: z.string().trim().min(1).max(200), page: pageInput }))
    .query(({ input }) => searchAll(input.query, input.page ?? 1)),

  searchTitles: publicProcedure
    .input(
      z.object({
        query: z.string().trim().min(1).max(200),
        mediaType: mediaTypeInput,
        page: pageInput,
        year: yearInput.optional(),
      }),
    )
    .query(({ input }) =>
      searchByMedia(input.query, input.mediaType, input.page ?? 1, input.year),
    ),

  searchPeople: publicProcedure
    .input(z.object({ query: z.string().trim().min(1).max(200), page: pageInput }))
    .query(({ input }) => searchPeople(input.query, input.page ?? 1)),

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
