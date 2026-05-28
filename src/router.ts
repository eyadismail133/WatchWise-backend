import { router } from "./trpc.js";
import movieRouter from "./routers/movie.router.js";
import watchlistRouter from "./routers/watchlist.router.js";
import favoriteRouter from "./routers/favorite.router.js";

export const appRouter = router({
  movie: movieRouter,
  watchlist: watchlistRouter,
  favorite: favoriteRouter,
});

export type AppRouter = typeof appRouter;
