import prisma from "../../lib/prisma.js";
import { ActivityType, TmdbMediaType, Prisma } from "../../generated/prisma/index.js";

export async function recordActivity(
  userId: number,
  type: ActivityType,
  opts: { tmdbId?: number; mediaType?: TmdbMediaType; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await prisma.activity.create({
      data: {
        userId,
        type,
        tmdbId: opts.tmdbId ?? null,
        mediaType: opts.mediaType ?? null,
        ...(opts.metadata ? { metadata: opts.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  } catch (err) {
    // Best-effort: never let activity logging break core mutations
    console.error("[activity] Failed to record activity:", err);
  }
}
