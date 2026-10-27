import { mountFlights } from './figure.js';

/* The interactive flight figures for "Flights from a satellite view". Same mountArticle contract
 * as the other articles: mount into the post's main element, return a cleanup for the blog's
 * client-side page transitions. */
export function mountArticle(root = document) {
  const controller = new AbortController();
  mountFlights(root, controller.signal);
  return () => controller.abort();
}
