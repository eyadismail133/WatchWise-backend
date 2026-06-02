import { router } from "./trpc.js";
import movieRouter from "./routers/movie.router.js";
import watchlistRouter from "./routers/watchlist.router.js";
import favoriteRouter from "./routers/favorite.router.js";
import { userRouter } from "./routers/user.router.js";
import { socialRouter } from "./routers/social.router.js";
import { activityRouter } from "./routers/activity.router.js";
import { commentRouter } from "./routers/comment.router.js";

export const appRouter = router({
  movie: movieRouter,
  watchlist: watchlistRouter,
  favorite: favoriteRouter,
  user: userRouter,
  social: socialRouter,
  activity: activityRouter,
  comment: commentRouter,
});

export type AppRouter = typeof appRouter;
