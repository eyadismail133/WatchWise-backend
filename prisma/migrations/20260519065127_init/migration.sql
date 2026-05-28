-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('free', 'premium');

-- CreateEnum
CREATE TYPE "TitleType" AS ENUM ('movie', 'series');

-- CreateEnum
CREATE TYPE "WatchlistStatus" AS ENUM ('want_to_watch', 'watched', 'skipped');

-- CreateEnum
CREATE TYPE "HiddenGemStatus" AS ENUM ('yes', 'no');

-- CreateEnum
CREATE TYPE "RecommendationFeedback" AS ENUM ('positive', 'negative', 'neutral');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "unionId" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255),
    "email" VARCHAR(320),
    "avatar" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSignInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "titles" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "type" "TitleType" NOT NULL,
    "description" TEXT,
    "genres" JSONB,
    "cast" JSONB,
    "director" VARCHAR(255),
    "releaseYear" INTEGER,
    "rating" DOUBLE PRECISION,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "moods" JSONB,
    "streamingPlatforms" JSONB,
    "popularityScore" DOUBLE PRECISION DEFAULT 50,
    "hiddenGemScore" DOUBLE PRECISION DEFAULT 0,
    "imdbRating" DOUBLE PRECISION,
    "rottenTomatoesRating" INTEGER,
    "metacriticRating" INTEGER,
    "runtime" INTEGER,
    "language" VARCHAR(100),
    "country" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "titleId" INTEGER NOT NULL,
    "status" "WatchlistStatus" NOT NULL DEFAULT 'want_to_watch',
    "userRating" INTEGER,
    "tags" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taste_profiles" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "favoriteGenres" JSONB,
    "favoriteMoods" JSONB,
    "favoriteActors" JSONB,
    "favoriteDirectors" JSONB,
    "dislikedPatterns" JSONB,
    "averageRating" DOUBLE PRECISION,
    "narrativeScore" DOUBLE PRECISION DEFAULT 50,
    "visualScore" DOUBLE PRECISION DEFAULT 50,
    "emotionalScore" DOUBLE PRECISION DEFAULT 50,
    "pacingScore" DOUBLE PRECISION DEFAULT 50,
    "eraScore" DOUBLE PRECISION DEFAULT 50,
    "genreBreadthScore" DOUBLE PRECISION DEFAULT 50,
    "aiSummary" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taste_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "titleId" INTEGER NOT NULL,
    "explanation" TEXT,
    "matchReason" TEXT,
    "confidence" DOUBLE PRECISION,
    "moodTags" JSONB,
    "similarTitles" JSONB,
    "isHiddenGem" "HiddenGemStatus" NOT NULL DEFAULT 'no',
    "userFeedback" "RecommendationFeedback",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_unionId_key" ON "users"("unionId");

-- CreateIndex
CREATE UNIQUE INDEX "taste_profiles_userId_key" ON "taste_profiles"("userId");

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taste_profiles" ADD CONSTRAINT "taste_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
