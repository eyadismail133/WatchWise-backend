import axios from "axios";
import { TRPCError } from "@trpc/server";

const API_KEY = process.env.TMDB_API_KEY;

const tmdb = axios.create({
  // Overridable for local end-to-end tests against a fake TMDB server.
  baseURL: process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3",
  timeout: 10_000,
  params: {
    api_key: API_KEY,
  },
});

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export type MediaType = "movie" | "tv" | undefined;
export type TimeWindow = "day" | "week";

type ImageSize =
  | "w45"
  | "w92"
  | "w154"
  | "w185"
  | "w300"
  | "w342"
  | "w500"
  | "w780"
  | "w1280"
  | "h632"
  | "original";

// ---------------------------------------------------------------------------
// Small in-memory TTL cache with in-flight de-duplication.
// TMDB data changes slowly, so caching cuts latency and protects the API key
// from bursts (e.g. taste-profile loops that request many details at once).
// This is per-process, like the existing rate limiter.
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 600;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

export function clearTmdbCache() {
  responseCache.clear();
  inFlight.clear();
  genreMapCache = null;
  genreListCache = null;
}

function cacheKey(path: string, params: Record<string, unknown>) {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
  return `${path}?${sorted}`;
}

async function cachedGet<T>(
  path: string,
  params: Record<string, unknown> = {},
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const key = cacheKey(path, params);
  const now = Date.now();
  const hit = responseCache.get(key);

  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const request = tmdb
    .get(path, { params })
    .then((res) => {
      const data = res.data as T;
      if (responseCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = responseCache.keys().next().value;
        if (oldest !== undefined) responseCache.delete(oldest);
      }
      responseCache.set(key, { expiresAt: Date.now() + ttlMs, value: data });
      return data;
    })
    .catch((err: unknown) => {
      // Never leak upstream details (URLs, keys) to clients; map to API errors.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not found in the catalog", cause: err });
      }
      if (status === 429) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Catalog is busy, try again shortly", cause: err });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Catalog service unavailable", cause: err });
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NormalizedTitle {
  id: number;
  title: string;
  type: "movie" | "series";
  description: string;
  genres: string[];
  moods: string[];
  rating: number;
  popularity_score: number;
  hidden_gem_score: number;
  poster_path: string | null;
  backdrop_path: string | null;
  backdrop_hd: string | null;
  releaseDate: string | null;
  mediaType: MediaType;
  voteCount: number;
  originalLanguage: string | null;
}

export interface PersonCard {
  id: number;
  name: string;
  profile_path: string | null;
  image: string | null;
}

export interface CastCard extends PersonCard {
  character: string | null;
}

export interface CrewCard extends PersonCard {
  jobs: string[];
  department: string | null;
}

export interface TitleDetail extends NormalizedTitle {
  runtime: number | null;
  tagline: string | null;
  status: string | null;
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  releaseYear: number | null;

  // old compatibility fields
  cast: string[];
  director: string | null;

  // rich person fields
  castCards: CastCard[];
  directorCard: PersonCard | null;

  language: string | null;
  country: string | null;
  imdbRating: number | null;
  trailerKey: string | null;
}

export interface VideoItem {
  key: string;
  name: string;
  type: string;
  official: boolean;
  publishedAt: string | null;
  thumbnail: string;
}

export interface GalleryImage {
  url: string;
  thumb: string;
  width: number;
  height: number;
  aspectRatio: number;
}

export interface CompanyItem {
  id: number;
  name: string;
  logo: string | null;
  country: string | null;
}

export interface ProviderItem {
  id: number;
  name: string;
  logo: string | null;
  priority: number;
}

export interface WatchProviders {
  region: string;
  link: string | null;
  stream: ProviderItem[];
  rent: ProviderItem[];
  buy: ProviderItem[];
  free: ProviderItem[];
}

export interface ReviewItem {
  id: string;
  author: string;
  username: string | null;
  avatar: string | null;
  rating: number | null;
  content: string;
  createdAt: string;
  url: string | null;
}

export interface SeasonSummary {
  id: number;
  seasonNumber: number;
  name: string;
  overview: string;
  poster: string | null;
  airDate: string | null;
  episodeCount: number;
  rating: number;
}

export interface EpisodeSummary {
  id: number;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
  airDate: string | null;
  still: string | null;
  overview: string;
  runtime: number | null;
  rating: number;
  episodeType: string | null;
}

export interface RichTitleDetail extends TitleDetail {
  originalTitle: string | null;
  homepage: string | null;
  certification: string | null;
  budget: number | null;
  revenue: number | null;
  genreList: { id: number; name: string }[];
  keywords: { id: number; name: string }[];
  spokenLanguages: string[];
  productionCompanies: CompanyItem[];
  networks: CompanyItem[];
  createdBy: PersonCard[];
  crewHighlights: CrewCard[];
  collection: {
    id: number;
    name: string;
    poster: string | null;
    backdrop: string | null;
  } | null;
  videos: VideoItem[];
  gallery: {
    backdrops: GalleryImage[];
    posters: GalleryImage[];
    logo: string | null;
  };
  watchProviders: WatchProviders | null;
  recommendations: NormalizedTitle[];
  reviews: ReviewItem[];
  reviewCount: number;
  externalIds: {
    imdb: string | null;
    facebook: string | null;
    instagram: string | null;
    twitter: string | null;
    wikidata: string | null;
  };
  seasons: SeasonSummary[];
  lastEpisode: EpisodeSummary | null;
  nextEpisode: EpisodeSummary | null;
  firstAirDate: string | null;
  lastAirDate: string | null;
  inProduction: boolean | null;
}

export interface PaginatedTitles {
  results: NormalizedTitle[];
  page: number;
  totalPages: number;
  totalResults: number;
}

export interface DiscoverParams {
  page?: number;
  sort_by?: string;
  with_genres?: string;
  year?: number;
}

export interface PersonSummary {
  id: number;
  name: string;
  image: string | null;
  knownForDepartment: string | null;
  knownFor: string[];
  popularity: number;
}

export interface PaginatedPeople {
  results: PersonSummary[];
  page: number;
  totalPages: number;
  totalResults: number;
}

export interface CreditItem {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  poster: string | null;
  backdrop: string | null;
  releaseDate: string | null;
  year: number | null;
  role: string | null;
  rating: number;
  voteCount: number;
  popularity: number;
  episodeCount: number | null;
}

export interface PersonDetail {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownForDepartment: string | null;
  gender: "female" | "male" | "non-binary" | null;
  alsoKnownAs: string[];
  homepage: string | null;
  image: string | null;
  imageHd: string | null;
  popularity: number;
  photos: GalleryImage[];
  externalIds: {
    imdb: string | null;
    instagram: string | null;
    twitter: string | null;
    facebook: string | null;
    tiktok: string | null;
  };
  knownFor: CreditItem[];
  cast: CreditItem[];
  crew: CreditItem[];
  stats: {
    totalCredits: number;
    movies: number;
    shows: number;
    averageRating: number | null;
    firstYear: number | null;
    latestYear: number | null;
  };
}

// ---------------------------------------------------------------------------
// Raw TMDB shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface RawListItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  media_type?: string;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  original_language?: string;
}

interface RawPaged<T> {
  results: T[];
  page: number;
  total_pages: number;
  total_results: number;
}

interface RawImage {
  file_path: string;
  width: number;
  height: number;
  aspect_ratio?: number;
  iso_639_1?: string | null;
  vote_average?: number;
}

interface RawPersonCredit {
  id: number;
  name: string;
  profile_path?: string | null;
  character?: string | null;
  job?: string;
  department?: string;
  order?: number;
}

interface RawProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface RawEpisode {
  id: number;
  episode_type?: string | null;
  vote_count?: number;
  name: string;
  season_number: number;
  episode_number: number;
  air_date?: string | null;
  still_path?: string | null;
  overview?: string;
  runtime?: number | null;
  vote_average?: number;
}

interface RawDetail extends RawListItem {
  imdb_id?: string | null;
  runtime?: number | null;
  episode_run_time?: number[];
  tagline?: string | null;
  status?: string | null;
  number_of_seasons?: number | null;
  number_of_episodes?: number | null;
  homepage?: string | null;
  budget?: number;
  revenue?: number;
  in_production?: boolean;
  last_air_date?: string | null;
  production_countries?: { iso_3166_1: string; name: string }[];
  origin_country?: string[];
  spoken_languages?: { english_name?: string; name?: string }[];
  production_companies?: {
    id: number;
    name: string;
    logo_path?: string | null;
    origin_country?: string;
  }[];
  networks?: {
    id: number;
    name: string;
    logo_path?: string | null;
    origin_country?: string;
  }[];
  created_by?: { id: number; name: string; profile_path?: string | null }[];
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
  } | null;
  seasons?: {
    id: number;
    season_number: number;
    name: string;
    overview?: string;
    poster_path?: string | null;
    air_date?: string | null;
    episode_count?: number;
    vote_average?: number;
  }[];
  last_episode_to_air?: RawEpisode | null;
  next_episode_to_air?: RawEpisode | null;
  credits?: { cast?: RawPersonCredit[]; crew?: RawPersonCredit[] };
  videos?: {
    results?: {
      site: string;
      type: string;
      key: string;
      name: string;
      official?: boolean;
      published_at?: string;
    }[];
  };
  images?: { backdrops?: RawImage[]; posters?: RawImage[]; logos?: RawImage[] };
  keywords?: {
    keywords?: { id: number; name: string }[];
    results?: { id: number; name: string }[];
  };
  release_dates?: {
    results?: {
      iso_3166_1: string;
      release_dates: { certification: string; type?: number }[];
    }[];
  };
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] };
  "watch/providers"?: {
    results?: Record<
      string,
      {
        link?: string;
        flatrate?: RawProvider[];
        rent?: RawProvider[];
        buy?: RawProvider[];
        free?: RawProvider[];
        ads?: RawProvider[];
      }
    >;
  };
  recommendations?: RawPaged<RawListItem>;
  reviews?: RawPaged<RawReview>;
  external_ids?: {
    imdb_id?: string | null;
    facebook_id?: string | null;
    instagram_id?: string | null;
    twitter_id?: string | null;
    wikidata_id?: string | null;
  };
}

interface RawReview {
  id: string;
  author: string;
  content: string;
  created_at: string;
  url?: string;
  author_details?: {
    username?: string;
    avatar_path?: string | null;
    rating?: number | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function imageUrl(
  path: string | null | undefined,
  size: ImageSize = "w500",
): string | null {
  if (!path) return null;

  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function yearOf(date: string | null | undefined): number | null {
  if (!date || date.length < 4) return null;
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function resolveMediaType(item: {
  media_type?: string;
  title?: string;
  name?: string;
  first_air_date?: string;
  release_date?: string;
}): MediaType {
  // Explicit TMDB media_type always wins
  if (item.media_type === "tv") return "tv";
  if (item.media_type === "movie") return "movie";

  // TV detection
  if (item.name) return "tv";
  if (item.first_air_date && !item.release_date) return "tv";

  // Movie detection
  if (item.title) return "movie";
  if (item.release_date) return "movie";

  return undefined;
}

let genreMapCache: Map<number, string> | null = null;
let genreListCache: {
  movie: { id: number; name: string }[];
  tv: { id: number; name: string }[];
} | null = null;

async function loadGenres() {
  if (genreMapCache && genreListCache) return;

  const [movies, tv] = await Promise.all([
    cachedGet<{ genres: { id: number; name: string }[] }>(
      "/genre/movie/list",
      {},
      24 * 60 * 60 * 1000,
    ),
    cachedGet<{ genres: { id: number; name: string }[] }>(
      "/genre/tv/list",
      {},
      24 * 60 * 60 * 1000,
    ),
  ]);

  const map = new Map<number, string>();
  for (const g of movies.genres ?? []) map.set(g.id, g.name);
  for (const g of tv.genres ?? []) map.set(g.id, g.name);

  genreMapCache = map;
  genreListCache = { movie: movies.genres ?? [], tv: tv.genres ?? [] };
}

/** Best-effort genre warm-up: list endpoints still work if this fails. */
async function ensureGenres() {
  try {
    await loadGenres();
  } catch {
    // ignore: list items fall back to no genre names
  }
}

export function normalizeListItem(
  item: RawListItem,
  fallbackMediaType?: MediaType,
): NormalizedTitle {
  const mediaType = resolveMediaType(item) ?? fallbackMediaType;

  const genres =
    item.genres?.map((g) => g.name) ??
    (item.genre_ids?.length
      ? item.genre_ids
          .map((id) => genreMapCache?.get(id))
          .filter((name): name is string => Boolean(name))
      : []);

  const rating = item.vote_average ?? 0;
  const voteCount = item.vote_count ?? 0;
  const popularity = item.popularity ?? 0;

  // Hidden gem: well rated, enough votes to be trustworthy, but not hugely popular.
  const hiddenGemScore =
    rating >= 7 && voteCount >= 80
      ? Math.round(
          Math.max(
            0,
            Math.min(100, (rating - 6) * 25 - Math.log10(popularity + 1) * 12 + 40),
          ),
        )
      : 0;

  return {
    id: item.id,
    title: item.title ?? item.name ?? "Unknown",
    type: mediaType === "tv" ? "series" : "movie",
    description: item.overview ?? "",
    genres,
    moods: [],
    rating,
    popularity_score: popularity,
    hidden_gem_score: hiddenGemScore,
    poster_path: imageUrl(item.poster_path),
    backdrop_path: imageUrl(item.backdrop_path, "w780"),
    backdrop_hd: imageUrl(item.backdrop_path, "w1280"),
    releaseDate: item.release_date || item.first_air_date || null,
    mediaType,
    voteCount,
    originalLanguage: item.original_language ?? null,
  };
}

function toPaginated(
  data: RawPaged<RawListItem>,
  fallbackMediaType?: MediaType,
): PaginatedTitles {
  return {
    results: (data.results ?? []).map((r) =>
      normalizeListItem(r, fallbackMediaType),
    ),
    page: data.page ?? 1,
    // TMDB rejects page > 500 on most list endpoints.
    totalPages: Math.min(data.total_pages ?? 1, 500),
    totalResults: data.total_results ?? 0,
  };
}

function mapImages(images: RawImage[] | undefined, limit: number): GalleryImage[] {
  return (images ?? [])
    .slice()
    .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
    .slice(0, limit)
    .map((img) => ({
      url: imageUrl(img.file_path, "original")!,
      thumb: imageUrl(img.file_path, img.width > img.height ? "w780" : "w342")!,
      width: img.width,
      height: img.height,
      aspectRatio: img.aspect_ratio ?? img.width / Math.max(img.height, 1),
    }));
}

function mapProviders(list: RawProvider[] | undefined): ProviderItem[] {
  return (list ?? [])
    .slice()
    .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
    .map((p) => ({
      id: p.provider_id,
      name: p.provider_name,
      logo: imageUrl(p.logo_path, "w92"),
      priority: p.display_priority ?? 99,
    }));
}

function mapEpisode(ep: RawEpisode | null | undefined): EpisodeSummary | null {
  if (!ep) return null;
  return {
    id: ep.id,
    name: ep.name,
    seasonNumber: ep.season_number,
    episodeNumber: ep.episode_number,
    airDate: ep.air_date ?? null,
    still: imageUrl(ep.still_path, "w300"),
    overview: ep.overview ?? "",
    runtime: ep.runtime ?? null,
    rating: ep.vote_average ?? 0,
    episodeType: ep.episode_type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Discover / lists
// ---------------------------------------------------------------------------

export async function discoverMovies(
  params: DiscoverParams = {},
): Promise<PaginatedTitles> {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem>>("/discover/movie", {
    page: params.page ?? 1,
    sort_by: params.sort_by ?? "popularity.desc",
    with_genres: params.with_genres,
    primary_release_year: params.year,
    "vote_count.gte": params.sort_by?.startsWith("vote_average") ? 300 : undefined,
  });

  return toPaginated(data, "movie");
}

export async function discoverTv(
  params: DiscoverParams = {},
): Promise<PaginatedTitles> {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem>>("/discover/tv", {
    page: params.page ?? 1,
    sort_by: params.sort_by ?? "popularity.desc",
    with_genres: params.with_genres,
    first_air_date_year: params.year,
    "vote_count.gte": params.sort_by?.startsWith("vote_average") ? 200 : undefined,
  });

  return toPaginated(data, "tv");
}

export type DiscoverSort =
  | "popularity"
  | "rating"
  | "newest"
  | "oldest"
  | "votes"
  | "revenue"
  | "title";

export interface AdvancedDiscoverParams {
  mediaType: "movie" | "tv";
  page?: number;
  sort?: DiscoverSort;
  genres?: number[];
  excludeGenres?: number[];
  yearFrom?: number;
  yearTo?: number;
  ratingMin?: number;
  voteCountMin?: number;
  runtimeMin?: number;
  runtimeMax?: number;
  language?: string;
  providers?: number[];
  region?: string;
  keywords?: number[];
  withPeople?: number[];
}

function sortParam(mediaType: "movie" | "tv", sort: DiscoverSort): string {
  const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
  switch (sort) {
    case "rating":
      return "vote_average.desc";
    case "newest":
      return `${dateField}.desc`;
    case "oldest":
      return `${dateField}.asc`;
    case "votes":
      return "vote_count.desc";
    case "revenue":
      return mediaType === "movie" ? "revenue.desc" : "popularity.desc";
    case "title":
      return mediaType === "movie" ? "title.asc" : "name.asc";
    default:
      return "popularity.desc";
  }
}

export async function discoverAdvanced(
  params: AdvancedDiscoverParams,
): Promise<PaginatedTitles> {
  await ensureGenres();
  const isMovie = params.mediaType === "movie";
  const sort = params.sort ?? "popularity";
  const dateField = isMovie ? "primary_release_date" : "first_air_date";
  const today = new Date().toISOString().slice(0, 10);

  const query: Record<string, unknown> = {
    page: params.page ?? 1,
    sort_by: sortParam(params.mediaType, sort),
    include_adult: false,
    with_genres: params.genres?.length ? params.genres.join(",") : undefined,
    without_genres: params.excludeGenres?.length
      ? params.excludeGenres.join(",")
      : undefined,
    [`${dateField}.gte`]: params.yearFrom ? `${params.yearFrom}-01-01` : undefined,
    [`${dateField}.lte`]: params.yearTo
      ? `${params.yearTo}-12-31`
      : sort === "newest"
        ? today
        : undefined,
    "vote_average.gte": params.ratingMin,
    "vote_count.gte":
      params.voteCountMin ?? (sort === "rating" || (params.ratingMin ?? 0) > 0 ? 150 : undefined),
    "with_runtime.gte": params.runtimeMin,
    "with_runtime.lte": params.runtimeMax,
    with_original_language: params.language,
    with_watch_providers: params.providers?.length
      ? params.providers.join("|")
      : undefined,
    watch_region: params.providers?.length ? (params.region ?? "US") : undefined,
    with_keywords: params.keywords?.length ? params.keywords.join("|") : undefined,
    with_people: isMovie && params.withPeople?.length ? params.withPeople.join(",") : undefined,
  };

  const data = await cachedGet<RawPaged<RawListItem>>(
    isMovie ? "/discover/movie" : "/discover/tv",
    query,
  );

  return toPaginated(data, params.mediaType);
}

export type ListCategory =
  | "popular"
  | "top_rated"
  | "now_playing"
  | "upcoming"
  | "airing_today"
  | "on_the_air";

export async function getList(
  mediaType: "movie" | "tv",
  category: ListCategory,
  page = 1,
): Promise<PaginatedTitles> {
  await ensureGenres();

  let resolved: ListCategory = category;
  if (mediaType === "movie") {
    if (category === "airing_today" || category === "on_the_air") resolved = "now_playing";
  } else {
    if (category === "now_playing") resolved = "airing_today";
    if (category === "upcoming") resolved = "on_the_air";
  }

  const data = await cachedGet<RawPaged<RawListItem>>(`/${mediaType}/${resolved}`, {
    page,
  });

  return toPaginated(data, mediaType);
}

export async function getGenres(mediaType: "movie" | "tv") {
  await loadGenres();
  return genreListCache?.[mediaType] ?? [];
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function pickDirectorCredit(credits?: {
  crew?: RawPersonCredit[];
}): RawPersonCredit | null {
  const director = credits?.crew?.find(
    (c) => c.job === "Director" || c.job === "Creator",
  );

  return director ?? null;
}

function normalizeCastCards(cast: RawPersonCredit[] | undefined, limit = 12): CastCard[] {
  return (cast ?? []).slice(0, limit).map((person) => ({
    id: person.id,
    name: person.name,
    character: person.character ?? null,
    profile_path: person.profile_path ?? null,
    image: imageUrl(person.profile_path, "w185"),
  }));
}

const HIGHLIGHT_JOBS = [
  "Director",
  "Creator",
  "Screenplay",
  "Writer",
  "Story",
  "Novel",
  "Characters",
  "Original Music Composer",
  "Music",
  "Director of Photography",
  "Editor",
  "Producer",
  "Executive Producer",
  "Casting",
  "Production Design",
  "Costume Design",
  "Visual Effects Supervisor",
];

function crewHighlights(crew: RawPersonCredit[] | undefined): CrewCard[] {
  const byPerson = new Map<number, CrewCard & { rank: number }>();

  for (const member of crew ?? []) {
    if (!member.job) continue;
    const rank = HIGHLIGHT_JOBS.indexOf(member.job);
    if (rank === -1) continue;

    const existing = byPerson.get(member.id);
    if (existing) {
      if (!existing.jobs.includes(member.job)) existing.jobs.push(member.job);
      existing.rank = Math.min(existing.rank, rank);
    } else {
      byPerson.set(member.id, {
        id: member.id,
        name: member.name,
        profile_path: member.profile_path ?? null,
        image: imageUrl(member.profile_path, "w185"),
        jobs: [member.job],
        department: member.department ?? null,
        rank,
      });
    }
  }

  return [...byPerson.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 18)
    .map(({ rank: _rank, ...rest }) => {
      void _rank;
      return rest;
    });
}

async function hydratePersonCard(person: {
  id: number;
  name: string;
  profile_path?: string | null;
}): Promise<PersonCard> {
  let profilePath = person.profile_path ?? null;
  let name = person.name;

  if (!profilePath) {
    try {
      const data = await cachedGet<{
        name?: string;
        profile_path?: string | null;
        images?: { profiles?: { file_path: string }[] };
      }>(`/person/${person.id}`, { append_to_response: "images" });

      name = data.name ?? name;

      profilePath =
        data.profile_path ?? data.images?.profiles?.[0]?.file_path ?? null;
    } catch {
      // ignore TMDB image failures
    }
  }

  return {
    id: person.id,
    name,
    profile_path: profilePath,
    image: imageUrl(profilePath, "w185"),
  };
}

function pickTrailer(videos?: RawDetail["videos"]): string | null {
  const youtube = (videos?.results ?? []).filter((v) => v.site === "YouTube");
  const trailer =
    youtube.find((v) => v.type === "Trailer" && v.official) ??
    youtube.find((v) => v.type === "Trailer") ??
    youtube.find((v) => v.type === "Teaser");

  return trailer?.key ?? null;
}

const VIDEO_ORDER = ["Trailer", "Teaser", "Clip", "Featurette", "Behind the Scenes", "Bloopers"];

function mapVideos(videos?: RawDetail["videos"]): VideoItem[] {
  return (videos?.results ?? [])
    .filter((v) => v.site === "YouTube")
    .sort((a, b) => {
      const ai = VIDEO_ORDER.indexOf(a.type);
      const bi = VIDEO_ORDER.indexOf(b.type);
      const orderDiff = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      if (orderDiff !== 0) return orderDiff;
      return Number(Boolean(b.official)) - Number(Boolean(a.official));
    })
    .slice(0, 16)
    .map((v) => ({
      key: v.key,
      name: v.name,
      type: v.type,
      official: Boolean(v.official),
      publishedAt: v.published_at ?? null,
      thumbnail: `https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`,
    }));
}

function baseDetail(data: RawDetail, castLimit: number): Omit<TitleDetail, "directorCard" | "director"> {
  const castCards = normalizeCastCards(data.credits?.cast, castLimit);
  const releaseYear = yearOf(data.release_date) ?? yearOf(data.first_air_date);

  return {
    ...normalizeListItem(data),
    runtime: data.runtime ?? data.episode_run_time?.[0] ?? null,
    tagline: data.tagline || null,
    status: data.status ?? null,
    numberOfSeasons: data.number_of_seasons ?? null,
    numberOfEpisodes: data.number_of_episodes ?? null,
    releaseYear,
    cast: castCards.map((c) => c.name),
    castCards,
    language: data.original_language?.toUpperCase() ?? null,
    country:
      data.production_countries?.[0]?.name ?? data.origin_country?.[0] ?? null,
    imdbRating: data.vote_average ?? null,
    trailerKey: pickTrailer(data.videos),
  };
}

/**
 * Lightweight detail used by watchlists, AI and taste-profile loops.
 * Response shape is unchanged from the original API.
 */
export async function getDetails(
  id: number,
  mediaType: MediaType,
): Promise<TitleDetail> {
  const path = mediaType === "movie" ? `/movie/${id}` : `/tv/${id}`;

  const data = await cachedGet<RawDetail>(path, {
    append_to_response: "credits,videos",
  });

  const directorCredit = pickDirectorCredit(data.credits);
  const directorCard = directorCredit
    ? await hydratePersonCard(directorCredit)
    : null;

  return {
    ...baseDetail(data, 12),
    director: directorCard?.name ?? null,
    directorCard,
  };
}

function pickCertification(data: RawDetail, region: string): string | null {
  const regions = [region, "US", "GB"];
  for (const r of regions) {
    const movieRelease = data.release_dates?.results?.find((x) => x.iso_3166_1 === r);
    const cert = movieRelease?.release_dates
      ?.slice()
      .sort((a, b) => (a.type ?? 9) - (b.type ?? 9))
      .find((d) => d.certification)?.certification;
    if (cert) return cert;

    const tvRating = data.content_ratings?.results?.find((x) => x.iso_3166_1 === r)?.rating;
    if (tvRating) return tvRating;
  }
  return null;
}

/** Full detail page payload: one TMDB request using append_to_response. */
export async function getFullDetails(
  id: number,
  mediaType: "movie" | "tv",
  region = "US",
): Promise<RichTitleDetail> {
  const isMovie = mediaType === "movie";
  const path = isMovie ? `/movie/${id}` : `/tv/${id}`;

  await ensureGenres();

  const data = await cachedGet<RawDetail>(path, {
    append_to_response: [
      "credits",
      "videos",
      "images",
      "keywords",
      isMovie ? "release_dates" : "content_ratings",
      "watch/providers",
      "recommendations",
      "reviews",
      "external_ids",
    ].join(","),
    include_image_language: "en,null",
  });

  const directorCredit = pickDirectorCredit(data.credits);
  const directorCard = directorCredit
    ? await hydratePersonCard(directorCredit)
    : data.created_by?.[0]
      ? await hydratePersonCard(data.created_by[0])
      : null;

  const providersForRegion =
    data["watch/providers"]?.results?.[region] ??
    data["watch/providers"]?.results?.US;

  const logos = (data.images?.logos ?? [])
    .slice()
    .sort((a, b) => {
      // prefer English, then highest voted
      const lang = Number(b.iso_639_1 === "en") - Number(a.iso_639_1 === "en");
      return lang !== 0 ? lang : (b.vote_average ?? 0) - (a.vote_average ?? 0);
    });

  const keywordList = data.keywords?.keywords ?? data.keywords?.results ?? [];

  return {
    ...baseDetail(data, 30),
    director: directorCard?.name ?? null,
    directorCard,

    originalTitle: data.original_title ?? data.original_name ?? null,
    homepage: data.homepage || null,
    certification: pickCertification(data, region),
    budget: isMovie && data.budget ? data.budget : null,
    revenue: isMovie && data.revenue ? data.revenue : null,
    genreList: data.genres ?? [],
    keywords: keywordList.slice(0, 24),
    spokenLanguages: (data.spoken_languages ?? [])
      .map((l) => l.english_name || l.name || "")
      .filter(Boolean),
    productionCompanies: (data.production_companies ?? []).slice(0, 8).map((c) => ({
      id: c.id,
      name: c.name,
      logo: imageUrl(c.logo_path, "w154"),
      country: c.origin_country || null,
    })),
    networks: (data.networks ?? []).map((n) => ({
      id: n.id,
      name: n.name,
      logo: imageUrl(n.logo_path, "w154"),
      country: n.origin_country || null,
    })),
    createdBy: (data.created_by ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      profile_path: p.profile_path ?? null,
      image: imageUrl(p.profile_path, "w185"),
    })),
    crewHighlights: crewHighlights(data.credits?.crew),
    collection: data.belongs_to_collection
      ? {
          id: data.belongs_to_collection.id,
          name: data.belongs_to_collection.name,
          poster: imageUrl(data.belongs_to_collection.poster_path, "w342"),
          backdrop: imageUrl(data.belongs_to_collection.backdrop_path, "w1280"),
        }
      : null,
    videos: mapVideos(data.videos),
    gallery: {
      backdrops: mapImages(data.images?.backdrops, 24),
      posters: mapImages(data.images?.posters, 16),
      logo: imageUrl(logos[0]?.file_path, "w500"),
    },
    watchProviders: providersForRegion
      ? {
          region: data["watch/providers"]?.results?.[region] ? region : "US",
          link: providersForRegion.link ?? null,
          stream: mapProviders(providersForRegion.flatrate),
          rent: mapProviders(providersForRegion.rent),
          buy: mapProviders(providersForRegion.buy),
          free: mapProviders([
            ...(providersForRegion.free ?? []),
            ...(providersForRegion.ads ?? []),
          ]),
        }
      : null,
    recommendations: (data.recommendations?.results ?? [])
      .slice(0, 20)
      .map((r) => normalizeListItem(r, mediaType)),
    reviews: (data.reviews?.results ?? []).slice(0, 6).map(mapReview),
    reviewCount: data.reviews?.total_results ?? 0,
    externalIds: {
      imdb: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
      facebook: data.external_ids?.facebook_id ?? null,
      instagram: data.external_ids?.instagram_id ?? null,
      twitter: data.external_ids?.twitter_id ?? null,
      wikidata: data.external_ids?.wikidata_id ?? null,
    },
    seasons: (data.seasons ?? [])
      .filter((s) => (s.episode_count ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        seasonNumber: s.season_number,
        name: s.name,
        overview: s.overview ?? "",
        poster: imageUrl(s.poster_path, "w342"),
        airDate: s.air_date ?? null,
        episodeCount: s.episode_count ?? 0,
        rating: s.vote_average ?? 0,
      })),
    lastEpisode: mapEpisode(data.last_episode_to_air),
    nextEpisode: mapEpisode(data.next_episode_to_air),
    firstAirDate: data.first_air_date ?? null,
    lastAirDate: data.last_air_date ?? null,
    inProduction: data.in_production ?? null,
  };
}

function mapReview(r: RawReview): ReviewItem {
  const avatarPath = r.author_details?.avatar_path ?? null;
  return {
    id: r.id,
    author: r.author,
    username: r.author_details?.username ?? null,
    avatar: avatarPath
      ? avatarPath.startsWith("/http")
        ? avatarPath.slice(1)
        : imageUrl(avatarPath, "w185")
      : null,
    rating: r.author_details?.rating ?? null,
    content: r.content,
    createdAt: r.created_at,
    url: r.url ?? null,
  };
}

export async function getReviews(
  id: number,
  mediaType: "movie" | "tv",
  page = 1,
) {
  const data = await cachedGet<RawPaged<RawReview>>(`/${mediaType}/${id}/reviews`, {
    page,
  });
  return {
    results: (data.results ?? []).map(mapReview),
    page: data.page ?? 1,
    totalPages: data.total_pages ?? 1,
    totalResults: data.total_results ?? 0,
  };
}

export async function getSeason(tvId: number, seasonNumber: number) {
  const data = await cachedGet<{
    id: number;
    name: string;
    overview?: string;
    poster_path?: string | null;
    air_date?: string | null;
    season_number: number;
    vote_average?: number;
    episodes?: (RawEpisode & {
      crew?: RawPersonCredit[];
      guest_stars?: RawPersonCredit[];
    })[];
  }>(`/tv/${tvId}/season/${seasonNumber}`);

  return {
    id: data.id,
    name: data.name,
    overview: data.overview ?? "",
    poster: imageUrl(data.poster_path, "w342"),
    airDate: data.air_date ?? null,
    seasonNumber: data.season_number,
    rating: data.vote_average ?? 0,
    episodes: (data.episodes ?? []).map((ep) => ({
      ...mapEpisode(ep)!,
      directors: (ep.crew ?? [])
        .filter((c) => c.job === "Director")
        .map((c) => c.name),
      guestStars: (ep.guest_stars ?? []).slice(0, 6).map((g) => ({
        id: g.id,
        name: g.name,
        character: g.character ?? null,
        image: imageUrl(g.profile_path, "w185"),
      })),
    })),
  };
}

export async function getCollection(id: number) {
  await ensureGenres();
  const data = await cachedGet<{
    id: number;
    name: string;
    overview?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    parts?: RawListItem[];
  }>(`/collection/${id}`);

  const parts = (data.parts ?? [])
    .map((p) => normalizeListItem(p, "movie"))
    .sort((a, b) => (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"));

  const rated = parts.filter((p) => p.voteCount > 0);

  return {
    id: data.id,
    name: data.name,
    overview: data.overview ?? "",
    poster: imageUrl(data.poster_path, "w500"),
    backdrop: imageUrl(data.backdrop_path, "w1280"),
    parts,
    averageRating: rated.length
      ? Math.round((rated.reduce((s, p) => s + p.rating, 0) / rated.length) * 10) / 10
      : null,
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

interface RawPersonListItem {
  id: number;
  name: string;
  profile_path?: string | null;
  known_for_department?: string;
  popularity?: number;
  media_type?: string;
  known_for?: RawListItem[];
}

function mapPersonSummary(p: RawPersonListItem): PersonSummary {
  return {
    id: p.id,
    name: p.name,
    image: imageUrl(p.profile_path, "w185"),
    knownForDepartment: p.known_for_department ?? null,
    knownFor: (p.known_for ?? [])
      .map((k) => k.title ?? k.name ?? "")
      .filter(Boolean)
      .slice(0, 3),
    popularity: p.popularity ?? 0,
  };
}

export async function getTrendingPeople(
  timeWindow: TimeWindow = "week",
  page = 1,
): Promise<PaginatedPeople> {
  const data = await cachedGet<RawPaged<RawPersonListItem>>(
    `/trending/person/${timeWindow}`,
    { page },
  );
  return {
    results: (data.results ?? []).filter((p) => p.profile_path).map(mapPersonSummary),
    page: data.page ?? 1,
    totalPages: Math.min(data.total_pages ?? 1, 500),
    totalResults: data.total_results ?? 0,
  };
}

export async function searchPeople(query: string, page = 1): Promise<PaginatedPeople> {
  const data = await cachedGet<RawPaged<RawPersonListItem>>(
    "/search/person",
    { query, page, include_adult: false },
    5 * 60 * 1000,
  );
  return {
    results: (data.results ?? []).map(mapPersonSummary),
    page: data.page ?? 1,
    totalPages: Math.min(data.total_pages ?? 1, 500),
    totalResults: data.total_results ?? 0,
  };
}

interface RawCombinedCredit extends RawListItem {
  character?: string;
  job?: string;
  episode_count?: number;
}

function mapCredit(c: RawCombinedCredit, role: string | null): CreditItem {
  const mediaType = c.media_type === "tv" ? "tv" : "movie";
  const releaseDate = c.release_date || c.first_air_date || null;
  return {
    id: c.id,
    mediaType,
    title: c.title ?? c.name ?? "Untitled",
    poster: imageUrl(c.poster_path, "w342"),
    backdrop: imageUrl(c.backdrop_path, "w780"),
    releaseDate,
    year: yearOf(releaseDate),
    role,
    rating: c.vote_average ?? 0,
    voteCount: c.vote_count ?? 0,
    popularity: c.popularity ?? 0,
    episodeCount: c.episode_count ?? null,
  };
}

const byDateDesc = (a: CreditItem, b: CreditItem) =>
  (b.releaseDate ?? "9999").localeCompare(a.releaseDate ?? "9999");

export async function getPerson(id: number): Promise<PersonDetail> {
  const data = await cachedGet<{
    id: number;
    name: string;
    biography?: string;
    birthday?: string | null;
    deathday?: string | null;
    place_of_birth?: string | null;
    known_for_department?: string | null;
    gender?: number;
    also_known_as?: string[];
    homepage?: string | null;
    profile_path?: string | null;
    popularity?: number;
    images?: { profiles?: RawImage[] };
    external_ids?: {
      imdb_id?: string | null;
      instagram_id?: string | null;
      twitter_id?: string | null;
      facebook_id?: string | null;
      tiktok_id?: string | null;
    };
    combined_credits?: { cast?: RawCombinedCredit[]; crew?: RawCombinedCredit[] };
  }>(`/person/${id}`, {
    append_to_response: "combined_credits,images,external_ids",
  });

  // Merge duplicate cast rows (same title, several characters) and crew jobs.
  const castMap = new Map<string, CreditItem>();
  for (const c of data.combined_credits?.cast ?? []) {
    const key = `${c.media_type}-${c.id}`;
    const existing = castMap.get(key);
    if (existing) {
      if (c.character && existing.role && !existing.role.includes(c.character)) {
        existing.role = `${existing.role} / ${c.character}`;
      }
    } else {
      castMap.set(key, mapCredit(c, c.character || null));
    }
  }

  const crewMap = new Map<string, CreditItem>();
  for (const c of data.combined_credits?.crew ?? []) {
    const key = `${c.media_type}-${c.id}`;
    const existing = crewMap.get(key);
    if (existing) {
      if (c.job && existing.role && !existing.role.includes(c.job)) {
        existing.role = `${existing.role}, ${c.job}`;
      }
    } else {
      crewMap.set(key, mapCredit(c, c.job || null));
    }
  }

  // Talk shows / award shows inflate TV credits; rank "known for" by vote count.
  const cast = [...castMap.values()].sort(byDateDesc);
  const crew = [...crewMap.values()].sort(byDateDesc);
  const primary = data.known_for_department === "Acting" || crew.length === 0 ? cast : crew;
  const knownFor = primary
    .filter((c) => c.poster && !(c.mediaType === "tv" && (c.episodeCount ?? 0) <= 2 && c.voteCount < 200))
    .slice()
    .sort((a, b) => b.voteCount * (b.rating || 1) - a.voteCount * (a.rating || 1))
    .slice(0, 16);

  const all = new Map<string, CreditItem>();
  for (const c of [...cast, ...crew]) all.set(`${c.mediaType}-${c.id}`, c);
  const allCredits = [...all.values()];
  const rated = allCredits.filter((c) => c.voteCount >= 20);
  const years = allCredits
    .map((c) => c.year)
    .filter((y): y is number => y !== null && y <= new Date().getFullYear() + 2);

  const genderMap: Record<number, PersonDetail["gender"]> = {
    1: "female",
    2: "male",
    3: "non-binary",
  };

  return {
    id: data.id,
    name: data.name,
    biography: data.biography ?? "",
    birthday: data.birthday ?? null,
    deathday: data.deathday ?? null,
    placeOfBirth: data.place_of_birth ?? null,
    knownForDepartment: data.known_for_department ?? null,
    gender: genderMap[data.gender ?? 0] ?? null,
    alsoKnownAs: (data.also_known_as ?? []).slice(0, 6),
    homepage: data.homepage || null,
    image: imageUrl(data.profile_path, "w500"),
    imageHd: imageUrl(data.profile_path, "h632"),
    popularity: data.popularity ?? 0,
    photos: mapImages(data.images?.profiles, 20),
    externalIds: {
      imdb: data.external_ids?.imdb_id ?? null,
      instagram: data.external_ids?.instagram_id ?? null,
      twitter: data.external_ids?.twitter_id ?? null,
      facebook: data.external_ids?.facebook_id ?? null,
      tiktok: data.external_ids?.tiktok_id ?? null,
    },
    knownFor,
    cast: cast.slice(0, 200),
    crew: crew.slice(0, 200),
    stats: {
      totalCredits: allCredits.length,
      movies: allCredits.filter((c) => c.mediaType === "movie").length,
      shows: allCredits.filter((c) => c.mediaType === "tv").length,
      averageRating: rated.length
        ? Math.round((rated.reduce((s, c) => s + c.rating, 0) / rated.length) * 10) / 10
        : null,
      firstYear: years.length ? Math.min(...years) : null,
      latestYear: years.length ? Math.max(...years) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchMulti(
  query: string,
  page = 1,
): Promise<PaginatedTitles> {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem>>(
    "/search/multi",
    { query, page, include_adult: false },
    5 * 60 * 1000,
  );

  const filtered = {
    ...data,
    results: (data.results ?? []).filter(
      (r) => r.media_type === "movie" || r.media_type === "tv",
    ),
  };

  return toPaginated(filtered);
}

/** Search across titles and people in a single TMDB call. */
export async function searchAll(query: string, page = 1) {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem & RawPersonListItem>>(
    "/search/multi",
    { query, page, include_adult: false },
    5 * 60 * 1000,
  );

  const results = data.results ?? [];
  return {
    titles: results
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .map((r) => normalizeListItem(r)),
    people: results
      .filter((r) => r.media_type === "person")
      .map((r) => mapPersonSummary(r)),
    page: data.page ?? 1,
    totalPages: Math.min(data.total_pages ?? 1, 500),
    totalResults: data.total_results ?? 0,
  };
}

export async function searchByMedia(
  query: string,
  mediaType: "movie" | "tv",
  page = 1,
  year?: number,
): Promise<PaginatedTitles> {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem>>(
    `/search/${mediaType}`,
    {
      query,
      page,
      include_adult: false,
      [mediaType === "movie" ? "primary_release_year" : "first_air_date_year"]: year,
    },
    5 * 60 * 1000,
  );
  return toPaginated(data, mediaType);
}

export async function getSimilar(
  id: number,
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  await ensureGenres();
  const path =
    mediaType === "movie" ? `/movie/${id}/similar` : `/tv/${id}/similar`;

  const data = await cachedGet<RawPaged<RawListItem>>(path, { page });

  return toPaginated(data, mediaType);
}

export async function getGenreMap(): Promise<Map<number, string>> {
  await loadGenres();
  return genreMapCache ?? new Map();
}

export function mapGenreIds(
  genreIds: number[],
  genreMap: Map<number, string>,
): string[] {
  return genreIds
    .map((id) => genreMap.get(id))
    .filter((name): name is string => Boolean(name));
}

export async function getImages(id: number, mediaType: MediaType) {
  const path =
    mediaType === "movie" ? `/movie/${id}/images` : `/tv/${id}/images`;

  const data = await cachedGet<{
    backdrops?: RawImage[];
    posters?: RawImage[];
    logos?: RawImage[];
  }>(path);

  const mapAll = (images: RawImage[]) =>
    images.map((img) => ({
      file_path: img.file_path,
      width: img.width,
      height: img.height,
      url: imageUrl(img.file_path, "original"),
    }));

  return {
    backdrops: mapAll(data.backdrops ?? []),
    posters: mapAll(data.posters ?? []),
    logos: mapAll(data.logos ?? []),
  };
}

export async function getTrending(
  timeWindow: TimeWindow = "week",
  mediaType: "all" | "movie" | "tv" = "all",
  page = 1,
): Promise<PaginatedTitles> {
  await ensureGenres();
  const data = await cachedGet<RawPaged<RawListItem>>(
    `/trending/${mediaType}/${timeWindow}`,
    { page },
  );

  const filtered = {
    ...data,
    results: (data.results ?? []).filter((r) => r.media_type !== "person"),
  };

  return toPaginated(filtered, mediaType === "all" ? undefined : mediaType);
}

export async function getTopRated(
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  return getList(mediaType === "tv" ? "tv" : "movie", "top_rated", page);
}

export async function getUpComing(
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  // TMDB has no /tv/upcoming endpoint; getList maps TV to "on_the_air".
  return getList(mediaType === "tv" ? "tv" : "movie", "upcoming", page);
}

export async function getProviderCatalog(
  mediaType: "movie" | "tv",
  region = "US",
): Promise<ProviderItem[]> {
  const data = await cachedGet<{ results?: (RawProvider & {
    display_priorities?: Record<string, number>;
  })[] }>(
    `/watch/providers/${mediaType}`,
    { watch_region: region },
    24 * 60 * 60 * 1000,
  );

  return (data.results ?? [])
    .map((p) => ({
      ...p,
      display_priority: p.display_priorities?.[region] ?? p.display_priority ?? 99,
    }))
    .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
    .slice(0, 24)
    .map((p) => ({
      id: p.provider_id,
      name: p.provider_name,
      logo: imageUrl(p.logo_path, "w92"),
      priority: p.display_priority ?? 99,
    }));
}

// ---------------------------------------------------------------------------
// Release calendar
// ---------------------------------------------------------------------------

export async function getReleaseCalendar(params: {
  mediaType: "movie" | "tv";
  from: string;
  to: string;
  region?: string;
  page?: number;
}): Promise<PaginatedTitles> {
  await ensureGenres();
  const isMovie = params.mediaType === "movie";
  const data = await cachedGet<RawPaged<RawListItem>>(
    isMovie ? "/discover/movie" : "/discover/tv",
    isMovie
      ? {
          page: params.page ?? 1,
          region: params.region,
          // Theatrical (limited + wide) releases in the viewer's region.
          with_release_type: "2|3",
          "release_date.gte": params.from,
          "release_date.lte": params.to,
          sort_by: "popularity.desc",
          include_adult: false,
        }
      : {
          page: params.page ?? 1,
          // Shows with an episode airing in the window.
          "air_date.gte": params.from,
          "air_date.lte": params.to,
          sort_by: "popularity.desc",
          include_adult: false,
          "vote_count.gte": 5,
        },
    30 * 60 * 1000,
  );
  return toPaginated(data, params.mediaType);
}

// ---------------------------------------------------------------------------
// Episode ratings (every season in one or two requests)
// ---------------------------------------------------------------------------

export async function getEpisodeRatings(tvId: number) {
  const base = await cachedGet<RawDetail>(`/tv/${tvId}`);
  const seasonNumbers = (base.seasons ?? [])
    .filter((s) => s.season_number > 0 && (s.episode_count ?? 0) > 0)
    .map((s) => s.season_number)
    .slice(0, 60);

  // append_to_response accepts at most 20 items per request.
  const chunks: number[][] = [];
  for (let i = 0; i < seasonNumbers.length; i += 20) {
    chunks.push(seasonNumbers.slice(i, i + 20));
  }

  const responses = await Promise.all(
    chunks.map((chunk) =>
      cachedGet<Record<string, unknown>>(`/tv/${tvId}`, {
        append_to_response: chunk.map((n) => `season/${n}`).join(","),
      }),
    ),
  );

  const merged: Record<string, unknown> = Object.assign({}, ...responses);
  const today = new Date().toISOString().slice(0, 10);

  const seasons = seasonNumbers.map((n) => {
    const season = merged[`season/${n}`] as
      | { episodes?: RawEpisode[] }
      | undefined;
    return {
      seasonNumber: n,
      episodes: (season?.episodes ?? []).map((ep) => ({
        episodeNumber: ep.episode_number,
        name: ep.name,
        airDate: ep.air_date ?? null,
        rating: ep.vote_average ?? 0,
        voteCount: ep.vote_count ?? 0,
        episodeType: ep.episode_type ?? null,
        aired: Boolean(ep.air_date && ep.air_date <= today),
      })),
    };
  });

  const rated = seasons
    .flatMap((s) => s.episodes.map((e) => ({ ...e, seasonNumber: s.seasonNumber })))
    .filter((e) => e.aired && e.voteCount > 0);
  const best = rated.slice().sort((a, b) => b.rating - a.rating)[0] ?? null;
  const worst = rated.slice().sort((a, b) => a.rating - b.rating)[0] ?? null;

  return {
    tvId,
    name: base.name ?? base.title ?? "",
    seasons,
    average: rated.length
      ? Math.round((rated.reduce((s, e) => s + e.rating, 0) / rated.length) * 10) / 10
      : null,
    best,
    worst,
  };
}

// ---------------------------------------------------------------------------
// Browse by keyword / company / network
// ---------------------------------------------------------------------------

export type BrowseKind = "keyword" | "company" | "network";

export async function browseBy(params: {
  kind: BrowseKind;
  id: number;
  mediaType: "movie" | "tv";
  page?: number;
  sort?: DiscoverSort;
}) {
  await ensureGenres();
  // Networks only exist on TV.
  const mediaType = params.kind === "network" ? "tv" : params.mediaType;

  const info = await cachedGet<{
    id: number;
    name: string;
    logo_path?: string | null;
    headquarters?: string;
    origin_country?: string;
    homepage?: string;
    description?: string;
  }>(`/${params.kind}/${params.id}`, {}, 24 * 60 * 60 * 1000);

  const filterKey =
    params.kind === "keyword"
      ? "with_keywords"
      : params.kind === "company"
        ? "with_companies"
        : "with_networks";

  const data = await cachedGet<RawPaged<RawListItem>>(
    mediaType === "movie" ? "/discover/movie" : "/discover/tv",
    {
      [filterKey]: params.id,
      page: params.page ?? 1,
      sort_by: sortParam(mediaType, params.sort ?? "popularity"),
      include_adult: false,
      "vote_count.gte": params.sort === "rating" ? 100 : undefined,
    },
  );

  return {
    kind: params.kind,
    id: info.id,
    name: info.name,
    logo: imageUrl(info.logo_path, "w300"),
    headquarters: info.headquarters || null,
    country: info.origin_country || null,
    homepage: info.homepage || null,
    description: info.description || null,
    mediaType,
    ...toPaginated(data, mediaType),
  };
}

export async function getRandomTrendingPick(
  mediaType: MediaType,
): Promise<NormalizedTitle> {
  const page = 1 + Math.floor(Math.random() * 3);
  const trending = await getTopRated(mediaType, page);

  const pool = trending.results;

  if (pool.length === 0) {
    const top = await getTopRated(mediaType, 1);

    return top.results[0]!;
  }

  return pool[Math.floor(Math.random() * pool.length)]!;
}

export default tmdb;
