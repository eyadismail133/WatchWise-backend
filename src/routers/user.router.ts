import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure, rateLimitedProcedure } from "../trpc.js";
import prisma from "../../lib/prisma.js";
import { getDetails, type MediaType } from "../../services/tmdb.js";

const RESERVED_USERNAMES = new Set([
  "admin", "api", "me", "settings", "feed", "users", "profile",
  "search", "login", "signup", "logout", "register", "help", "support",
  "about", "terms", "privacy", "watchwise",
]);

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be at most 30 characters")
  .regex(/^[a-z0-9_]+$/, "Username may only contain lowercase letters, numbers, and underscores");

function assertNotReserved(username: string) {
  if (RESERVED_USERNAMES.has(username)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That username is reserved." });
  }
}

const userPublicSelect = {
  id: true,
  name: true,
  username: true,
  bio: true,
  image: true,
  avatar: true,
  isWatchlistPublic: true,
  isActivityPublic: true,
  createdAt: true,
} as const;

export const userRouter = router({
  // Get another user's profile by username
  getProfile: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ input, ctx }) => {
      const user = await prisma.user.findUnique({
        where: { username: input.username.toLowerCase() },
        select: {
          ...userPublicSelect,
          _count: { select: { followers: true, following: true } },
        },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      const isOwner = ctx.userId === user.id;
      return { ...user, isOwner };
    }),

  // Get the signed-in user's own profile
  getMyProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: {
        ...userPublicSelect,
        email: true,
        _count: { select: { followers: true, following: true } },
      },
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    return user;
  }),

  // Update bio and/or avatar image
  updateProfile: rateLimitedProcedure
    .input(
      z.object({
        bio: z.string().max(500).optional(),
        image: z.string().url().optional(),
        name: z.string().min(1).max(255).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return prisma.user.update({
        where: { id: ctx.userId },
        data: {
          ...(input.bio !== undefined && { bio: input.bio.trim() }),
          ...(input.image !== undefined && { image: input.image }),
          ...(input.name !== undefined && { name: input.name.trim() }),
        },
        select: userPublicSelect,
      });
    }),

  // Check if a username is available
  checkUsername: publicProcedure
    .input(z.object({ username: usernameSchema }))
    .query(async ({ input, ctx }) => {
      if (RESERVED_USERNAMES.has(input.username)) return { available: false };
      const existing = await prisma.user.findUnique({
        where: { username: input.username },
        select: { id: true },
      });
      // Available if not taken, or taken by current user
      const available = !existing || existing.id === ctx.userId;
      return { available };
    }),

  // Set / change username
  setUsername: rateLimitedProcedure
    .input(z.object({ username: usernameSchema }))
    .mutation(async ({ input, ctx }) => {
      assertNotReserved(input.username);
      try {
        return await prisma.user.update({
          where: { id: ctx.userId },
          data: { username: input.username },
          select: { username: true },
        });
      } catch (err: any) {
        if (err?.code === "P2002") {
          throw new TRPCError({ code: "CONFLICT", message: "That username is already taken." });
        }
        throw err;
      }
    }),

  // Toggle watchlist / activity privacy
  updatePrivacy: protectedProcedure
    .input(
      z.object({
        isWatchlistPublic: z.boolean().optional(),
        isActivityPublic: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return prisma.user.update({
        where: { id: ctx.userId },
        data: {
          ...(input.isWatchlistPublic !== undefined && { isWatchlistPublic: input.isWatchlistPublic }),
          ...(input.isActivityPublic !== undefined && { isActivityPublic: input.isActivityPublic }),
        },
        select: { isWatchlistPublic: true, isActivityPublic: true },
      });
    }),

  // Search users by handle or display name (cursor-paginated)
  searchUsers: publicProcedure
    .input(z.object({ q: z.string().min(1).max(100), cursor: z.number().optional(), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const { q, cursor, limit } = input;
      const search = q.toLowerCase().trim();

      const items = await prisma.user.findMany({
        where: {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
          ],
        },
        select: {
          ...userPublicSelect,
          _count: { select: { followers: true } },
        },
        orderBy: [{ username: "asc" }],
        take: limit + 1,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      });

      const hasMore = items.length > limit;
      const results = hasMore ? items.slice(0, limit) : items;
      return { items: results, nextCursor: hasMore ? results[results.length - 1].id : undefined };
    }),

  // Set featured favorites (up to 5, ordered)
  setFeaturedFavorites: protectedProcedure
    .input(
      z.object({
        items: z
          .array(z.object({ tmdbId: z.number().int(), mediaType: z.enum(["movie", "tv"]) }))
          .max(5),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Clear existing featured ranks for this user
      await prisma.favorite.updateMany({
        where: { userId: ctx.userId },
        data: { featuredRank: null },
      });

      // Set new ranks
      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i];
        await prisma.favorite.updateMany({
          where: { userId: ctx.userId, tmdbId: item.tmdbId, mediaType: item.mediaType },
          data: { featuredRank: i + 1 },
        });
      }
      return { ok: true };
    }),

  // Get public watchlist for a user profile (respects isWatchlistPublic)
  getPublicWatchlist: publicProcedure
    .input(z.object({
      username: z.string(),
      status: z.enum(["want_to_watch", "watched"]).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const user = await prisma.user.findUnique({
        where: { username: input.username.toLowerCase() },
        select: { id: true, isWatchlistPublic: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      const isOwner = ctx.userId === user.id;
      if (!isOwner && !user.isWatchlistPublic) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This user's watchlist is private." });
      }

      const items = await prisma.watchlistItem.findMany({
        where: {
          userId: user.id,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });

      const titles = await Promise.all(
        items.map(async (item) => {
          try {
            const detail = await getDetails(item.tmdbId, item.mediaType as MediaType);
            return { ...item, title: detail };
          } catch {
            return null;
          }
        })
      );

      return titles.filter(Boolean);
    }),

  // Get featured favorites for a profile
  getFeaturedFavorites: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ input }) => {
      const user = await prisma.user.findUnique({
        where: { username: input.username.toLowerCase() },
        select: { id: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      const favorites = await prisma.favorite.findMany({
        where: { userId: user.id, featuredRank: { not: null } },
        orderBy: { featuredRank: "asc" },
        take: 5,
      });
      return favorites;
    }),
});
