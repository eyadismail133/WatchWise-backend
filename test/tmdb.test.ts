import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

process.env.TMDB_API_KEY = "test-key";

const tmdbModule = await import("../services/tmdb.js");
const client = tmdbModule.default;

type Call = { path: string; params: Record<string, unknown> };
let calls: Call[] = [];
let responses: Record<string, unknown> = {};

const genres = {
  "/genre/movie/list": { genres: [{ id: 28, name: "Action" }, { id: 18, name: "Drama" }] },
  "/genre/tv/list": { genres: [{ id: 10765, name: "Sci-Fi & Fantasy" }] },
};

beforeEach(() => {
  tmdbModule.clearTmdbCache();
  calls = [];
  responses = { ...genres };
  // Replace the axios GET with a deterministic in-memory provider (no network).
  (client as unknown as { get: unknown }).get = async (
    path: string,
    config?: { params?: Record<string, unknown> },
  ) => {
    calls.push({ path, params: config?.params ?? {} });
    if (!(path in responses)) {
      throw new Error(`Unexpected TMDB path ${path}`);
    }
    return { data: responses[path] };
  };
});

test("list items map genre ids to names and include HD backdrops", async () => {
  responses["/movie/popular"] = {
    page: 1,
    total_pages: 9000,
    total_results: 10,
    results: [
      {
        id: 1,
        title: "Heat",
        genre_ids: [28, 18, 999],
        backdrop_path: "/b.jpg",
        poster_path: "/p.jpg",
        vote_average: 8.3,
        vote_count: 5000,
        popularity: 40,
      },
    ],
  };

  const result = await tmdbModule.getList("movie", "popular");
  assert.deepEqual(result.results[0]!.genres, ["Action", "Drama"]);
  assert.equal(result.results[0]!.mediaType, "movie");
  assert.equal(result.results[0]!.backdrop_hd, "https://image.tmdb.org/t/p/w1280/b.jpg");
  assert.equal(result.totalPages, 500, "page count is capped at TMDB's limit");
});

test("TV upcoming maps to the on_the_air endpoint", async () => {
  responses["/tv/on_the_air"] = { page: 1, total_pages: 1, total_results: 0, results: [] };
  await tmdbModule.getUpComing("tv");
  assert.ok(calls.some((c) => c.path === "/tv/on_the_air"));
});

test("identical concurrent requests share one upstream call and are cached", async () => {
  responses["/movie/top_rated"] = { page: 1, total_pages: 1, total_results: 0, results: [] };
  await Promise.all([
    tmdbModule.getTopRated("movie"),
    tmdbModule.getTopRated("movie"),
  ]);
  await tmdbModule.getTopRated("movie");
  assert.equal(calls.filter((c) => c.path === "/movie/top_rated").length, 1);
});

test("advanced discover builds TMDB filters from validated params", async () => {
  responses["/discover/tv"] = { page: 2, total_pages: 3, total_results: 50, results: [] };
  await tmdbModule.discoverAdvanced({
    mediaType: "tv",
    page: 2,
    sort: "rating",
    genres: [18, 35],
    yearFrom: 2000,
    yearTo: 2010,
    ratingMin: 7,
    providers: [8, 9],
    region: "GB",
  });
  const call = calls.find((c) => c.path === "/discover/tv")!;
  assert.equal(call.params.sort_by, "vote_average.desc");
  assert.equal(call.params.with_genres, "18,35");
  assert.equal(call.params["first_air_date.gte"], "2000-01-01");
  assert.equal(call.params["first_air_date.lte"], "2010-12-31");
  assert.equal(call.params["vote_count.gte"], 150);
  assert.equal(call.params.with_watch_providers, "8|9");
  assert.equal(call.params.watch_region, "GB");
});

test("full details expose providers, certification, crew, media and recommendations", async () => {
  responses["/movie/42"] = {
    id: 42,
    title: "Arrival",
    overview: "Linguist meets heptapods.",
    release_date: "2016-11-10",
    runtime: 116,
    vote_average: 7.6,
    vote_count: 18000,
    genres: [{ id: 18, name: "Drama" }],
    budget: 47000000,
    revenue: 203000000,
    belongs_to_collection: null,
    credits: {
      cast: [{ id: 1, name: "Amy Adams", character: "Louise", profile_path: "/a.jpg" }],
      crew: [
        { id: 2, name: "Denis Villeneuve", job: "Director", department: "Directing", profile_path: "/d.jpg" },
        { id: 3, name: "Eric Heisserer", job: "Screenplay", department: "Writing" },
        { id: 2, name: "Denis Villeneuve", job: "Producer", department: "Production", profile_path: "/d.jpg" },
      ],
    },
    videos: {
      results: [
        { site: "YouTube", type: "Clip", key: "clip", name: "Clip" },
        { site: "YouTube", type: "Trailer", key: "trailer", name: "Trailer", official: true },
      ],
    },
    images: {
      backdrops: [{ file_path: "/bd.jpg", width: 1920, height: 1080, vote_average: 5 }],
      posters: [],
      logos: [{ file_path: "/logo.png", width: 500, height: 100, iso_639_1: "en" }],
    },
    keywords: { keywords: [{ id: 5, name: "alien" }] },
    release_dates: {
      results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13", type: 3 }] }],
    },
    "watch/providers": {
      results: {
        US: {
          link: "https://tmdb.org/watch",
          flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priority: 1 }],
          rent: [],
        },
      },
    },
    recommendations: {
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [{ id: 7, title: "Sicario", genre_ids: [18] }],
    },
    reviews: {
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [
        {
          id: "r1",
          author: "critic",
          content: "Great",
          created_at: "2020-01-01",
          author_details: { rating: 9, avatar_path: "/https://x.test/a.png" },
        },
      ],
    },
    external_ids: { imdb_id: "tt2543164" },
  };

  const detail = await tmdbModule.getFullDetails(42, "movie", "US");
  assert.equal(detail.title, "Arrival");
  assert.equal(detail.trailerKey, "trailer");
  assert.equal(detail.videos[0]!.type, "Trailer");
  assert.equal(detail.certification, "PG-13");
  assert.equal(detail.watchProviders?.stream[0]?.name, "Netflix");
  assert.equal(detail.gallery.logo, "https://image.tmdb.org/t/p/w500/logo.png");
  assert.deepEqual(detail.crewHighlights[0]!.jobs, ["Director", "Producer"]);
  assert.equal(detail.director, "Denis Villeneuve");
  assert.equal(detail.recommendations[0]!.mediaType, "movie");
  assert.deepEqual(detail.recommendations[0]!.genres, ["Drama"]);
  assert.equal(detail.reviews[0]!.avatar, "https://x.test/a.png");
  assert.equal(detail.externalIds.imdb, "tt2543164");
  assert.equal(detail.castCards[0]!.character, "Louise");
});

test("person details merge credits and compute stats", async () => {
  responses["/person/9"] = {
    id: 9,
    name: "Someone",
    known_for_department: "Acting",
    gender: 1,
    combined_credits: {
      cast: [
        { id: 1, media_type: "movie", title: "A", character: "X", release_date: "2001-01-01", poster_path: "/a.jpg", vote_count: 500, vote_average: 7 },
        { id: 1, media_type: "movie", title: "A", character: "Y", release_date: "2001-01-01", poster_path: "/a.jpg", vote_count: 500, vote_average: 7 },
        { id: 2, media_type: "tv", name: "B", character: "Z", first_air_date: "2010-05-01", poster_path: "/b.jpg", vote_count: 50, vote_average: 8, episode_count: 20 },
      ],
      crew: [],
    },
  };

  const person = await tmdbModule.getPerson(9);
  assert.equal(person.gender, "female");
  assert.equal(person.cast.length, 2);
  assert.equal(person.cast.find((c) => c.id === 1)!.role, "X / Y");
  assert.equal(person.stats.movies, 1);
  assert.equal(person.stats.shows, 1);
  assert.equal(person.stats.firstYear, 2001);
  assert.equal(person.stats.latestYear, 2010);
});

test("searchAll splits titles and people", async () => {
  responses["/search/multi"] = {
    page: 1,
    total_pages: 1,
    total_results: 2,
    results: [
      { id: 1, media_type: "movie", title: "Dune" },
      { id: 2, media_type: "person", name: "Zendaya", profile_path: "/z.jpg", known_for: [{ id: 1, title: "Dune" }] },
    ],
  };
  const result = await tmdbModule.searchAll("dune");
  assert.equal(result.titles.length, 1);
  assert.equal(result.people[0]!.name, "Zendaya");
  assert.deepEqual(result.people[0]!.knownFor, ["Dune"]);
});

test("list endpoints still work when genre lookup fails", async () => {
  delete responses["/genre/movie/list"];
  responses["/movie/now_playing"] = {
    page: 1,
    total_pages: 1,
    total_results: 1,
    results: [{ id: 3, title: "X", genre_ids: [28] }],
  };
  const result = await tmdbModule.getList("movie", "now_playing");
  assert.equal(result.results[0]!.title, "X");
});

test("release calendar asks for theatrical releases in the viewer's region", async () => {
  responses["/discover/movie"] = { page: 1, total_pages: 1, total_results: 0, results: [] };
  await tmdbModule.getReleaseCalendar({ mediaType: "movie", from: "2026-11-01", to: "2026-11-07", region: "EG" });
  const call = calls.find((c) => c.path === "/discover/movie")!;
  assert.equal(call.params.region, "EG");
  assert.equal(call.params.with_release_type, "2|3");
  assert.equal(call.params["release_date.gte"], "2026-11-01");
  assert.equal(call.params["release_date.lte"], "2026-11-07");
});

test("episode ratings merge appended seasons and find best/worst aired episodes", async () => {
  // The base request and the season-append request share a path; serve both.
  responses["/tv/77"] = {
    id: 77,
    name: "Show",
    seasons: [
      { id: 1, season_number: 0, episode_count: 2 },
      { id: 2, season_number: 1, episode_count: 2 },
      { id: 3, season_number: 2, episode_count: 1 },
    ],
    "season/1": {
      episodes: [
        { id: 10, name: "Pilot", season_number: 1, episode_number: 1, air_date: "2020-01-01", vote_average: 7.1, vote_count: 40 },
        { id: 11, name: "Peak", season_number: 1, episode_number: 2, air_date: "2020-01-08", vote_average: 9.4, vote_count: 80, episode_type: "finale" },
      ],
    },
    "season/2": {
      episodes: [
        { id: 12, name: "Future", season_number: 2, episode_number: 1, air_date: "2999-01-01", vote_average: 0, vote_count: 0 },
      ],
    },
  };
  const result = await tmdbModule.getEpisodeRatings(77);
  assert.deepEqual(result.seasons.map((s) => s.seasonNumber), [1, 2]);
  assert.equal(result.best?.name, "Peak");
  assert.equal(result.worst?.name, "Pilot");
  assert.equal(result.average, 8.3);
  assert.equal(result.seasons[0]!.episodes[1]!.episodeType, "finale");
  assert.equal(result.seasons[1]!.episodes[0]!.aired, false);
  const appendCall = calls.find((c) => c.path === "/tv/77" && c.params.append_to_response);
  assert.equal(appendCall?.params.append_to_response, "season/1,season/2");
});

test("browse by network forces TV and returns the network header", async () => {
  responses["/network/213"] = { id: 213, name: "Netflix", logo_path: "/n.png", origin_country: "" };
  responses["/discover/tv"] = { page: 1, total_pages: 2, total_results: 30, results: [{ id: 1, name: "Dark" }] };
  const result = await tmdbModule.browseBy({ kind: "network", id: 213, mediaType: "movie" });
  assert.equal(result.mediaType, "tv");
  assert.equal(result.name, "Netflix");
  assert.equal(result.logo, "https://image.tmdb.org/t/p/w300/n.png");
  assert.equal(calls.find((c) => c.path === "/discover/tv")!.params.with_networks, 213);
  assert.equal(result.results[0]!.mediaType, "tv");
});

test("upstream 404s become NOT_FOUND without leaking request details", async () => {
  (client as unknown as { get: unknown }).get = async () => {
    const err = Object.assign(new Error("Request failed with status code 404 https://api.themoviedb.org/3/movie/1?api_key=secret"), {
      isAxiosError: true,
      response: { status: 404 },
    });
    throw err;
  };
  await assert.rejects(tmdbModule.getDetails(1, "movie"), (e: { code?: string; message?: string }) => {
    assert.equal(e.code, "NOT_FOUND");
    assert.ok(!String(e.message).includes("api_key"));
    return true;
  });
});
