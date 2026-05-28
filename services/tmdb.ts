import axios from "axios";

const API_KEY = process.env.TMDB_API_KEY;

const tmdb = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  params: {
    api_key: API_KEY,
  },
});

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export type MediaType = "movie" | "tv" | undefined;
export type TimeWindow = "day" | "week";

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
  releaseDate: string | null;
  mediaType: MediaType;
}

export function imageUrl(
  path: string | null | undefined,
  size: "w185" | "w342" | "w500" | "w780" | "original" = "w500",
): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function resolveMediaType(item: {
  media_type?: string;
  title?: string;
  name?: string;
  first_air_date?: string;
}): MediaType {
  if (item.media_type === "tv" || item.media_type === "movie") {
    return item.media_type;
  }
  if (item.name && !item.title) return "tv";
  if (item.first_air_date && !item.title) return "tv";
  return "movie";
}

export function normalizeListItem(item: {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  popularity?: number;
  media_type?: string;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
}): NormalizedTitle {
  const mediaType = resolveMediaType(item);
  const genres =
    item.genres?.map((g) => g.name) ??
    (item.genre_ids?.length ? item.genre_ids.map(String) : []);

  return {
    id: item.id,
    title: item.title ?? item.name ?? "Unknown",
    type: mediaType === "tv" ? "series" : "movie",
    description: item.overview ?? "",
    genres,
    moods: [],
    rating: item.vote_average ?? 0,
    popularity_score: item.popularity ?? 0,
    hidden_gem_score: 0,
    poster_path: imageUrl(item.poster_path),
    backdrop_path: imageUrl(item.backdrop_path, "w780"),
    releaseDate: item.release_date ?? item.first_air_date ?? null,
    mediaType,
  };
}

export interface PaginatedTitles {
  results: NormalizedTitle[];
  page: number;
  totalPages: number;
  totalResults: number;
}

function toPaginated(data: {
  results: Parameters<typeof normalizeListItem>[0][];
  page: number;
  total_pages: number;
  total_results: number;
}): PaginatedTitles {
  return {
    results: data.results.map(normalizeListItem),
    page: data.page,
    totalPages: data.total_pages,
    totalResults: data.total_results,
  };
}

export interface DiscoverParams {
  page?: number;
  sort_by?: string;
  with_genres?: string;
  year?: number;
}

export async function discoverMovies(
  params: DiscoverParams = {},
): Promise<PaginatedTitles> {
  const { data } = await tmdb.get("/discover/movie", {
    params: {
      page: params.page ?? 1,
      sort_by: params.sort_by ?? "popularity.desc",
      with_genres: params.with_genres,
      primary_release_year: params.year,
    },
  });
  return toPaginated(data);
}

export async function discoverTv(
  params: DiscoverParams = {},
): Promise<PaginatedTitles> {
  const { data } = await tmdb.get("/discover/tv", {
    params: {
      page: params.page ?? 1,
      sort_by: params.sort_by ?? "popularity.desc",
      with_genres: params.with_genres,
      first_air_date_year: params.year,
    },
  });
  return toPaginated(data);
}

export interface TitleDetail extends NormalizedTitle {
  runtime: number | null;
  tagline: string | null;
  status: string | null;
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  releaseYear: number | null;
  cast: string[];
  director: string | null;
  language: string | null;
  country: string | null;
  imdbRating: number | null;
  trailerKey: string | null;
}

function pickDirector(credits?: {
  crew?: { job: string; name: string }[];
}): string | null {
  const director = credits?.crew?.find(
    (c) => c.job === "Director" || c.job === "Creator",
  );
  return director?.name ?? null;
}

function pickTrailer(videos?: {
  results?: { site: string; type: string; key: string }[];
}): string | null {
  const trailer = videos?.results?.find(
    (v) => v.site === "YouTube" && v.type === "Trailer",
  );
  return trailer?.key ?? null;
}

export async function getDetails(
  id: number,
  mediaType: MediaType,
): Promise<TitleDetail> {
  const path = mediaType === "movie" ? `/movie/${id}` : `/tv/${id}`;
  const { data } = await tmdb.get(path, {
    params: { append_to_response: "credits,videos" },
  });

  const releaseYear = data.release_date
    ? parseInt(data.release_date.slice(0, 4), 10)
    : data.first_air_date
      ? parseInt(data.first_air_date.slice(0, 4), 10)
      : null;

  const cast =
    data.credits?.cast?.slice(0, 12).map((c: { name: string }) => c.name) ?? [];

  return {
    ...normalizeListItem(data),
    runtime: data.runtime ?? data.episode_run_time?.[0] ?? null,
    tagline: data.tagline ?? null,
    status: data.status ?? null,
    numberOfSeasons: data.number_of_seasons ?? null,
    numberOfEpisodes: data.number_of_episodes ?? null,
    releaseYear,
    cast,
    director: pickDirector(data.credits),
    language: data.original_language?.toUpperCase() ?? null,
    country:
      data.production_countries?.[0]?.name ?? data.origin_country?.[0] ?? null,
    imdbRating: data.vote_average ?? null,
    trailerKey: pickTrailer(data.videos),
  };
}

export async function searchMulti(
  query: string,
  page = 1,
): Promise<PaginatedTitles> {
  const { data } = await tmdb.get("/search/multi", {
    params: { query, page, include_adult: false },
  });
  const filtered = {
    ...data,
    results: data.results.filter(
      (r: { media_type?: string }) =>
        r.media_type === "movie" || r.media_type === "tv",
    ),
  };
  return toPaginated(filtered);
}

export async function getSimilar(
  id: number,
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  const path =
    mediaType === "movie" ? `/movie/${id}/similar` : `/tv/${id}/similar`;
  const { data } = await tmdb.get(path, { params: { page } });
  return toPaginated(data);
}

let genreMapCache: Map<number, string> | null = null;

export async function getGenreMap(): Promise<Map<number, string>> {
  if (genreMapCache) return genreMapCache;

  const [movies, tv] = await Promise.all([
    tmdb.get("/genre/movie/list"),
    tmdb.get("/genre/tv/list"),
  ]);

  genreMapCache = new Map<number, string>();
  for (const g of movies.data.genres) {
    genreMapCache.set(g.id, g.name);
  }
  for (const g of tv.data.genres) {
    genreMapCache.set(g.id, g.name);
  }
  return genreMapCache;
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
  const { data } = await tmdb.get(path);
  const mapImages = (
    images: { file_path: string; width: number; height: number }[],
  ) =>
    images.map((img) => ({
      ...img,
      url: imageUrl(img.file_path, "original"),
    }));

  return {
    backdrops: mapImages(data.backdrops ?? []),
    posters: mapImages(data.posters ?? []),
    logos: mapImages(data.logos ?? []),
  };
}

export async function getTrending(
  timeWindow: TimeWindow = "week",
): Promise<PaginatedTitles> {
  const { data } = await tmdb.get(`/trending/all/${timeWindow}`);
  return toPaginated(data);
}

export async function getTopRated(
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  const path = mediaType === "movie" ? "/movie/top_rated" : "/tv/top_rated";
  const { data } = await tmdb.get(path, { params: { page } });
  return toPaginated(data);
}

export async function getUpComing(
  mediaType: MediaType,
  page = 1,
): Promise<PaginatedTitles> {
  const path = mediaType === "movie" ? "/movie/upcoming" : "/tv/upcoming";
  const { data } = await tmdb.get(path, { params: { page } });
  return toPaginated(data);
}

export async function getRandomTrendingPick(
  mediaType: MediaType,
): Promise<NormalizedTitle> {
  const trending = await getTopRated(mediaType);
  const pool = trending.results;
  if (pool.length === 0) {
    const top = await getTopRated(mediaType, 1);
    return top.results[0]!;
  }
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export default tmdb;
