/**
 * Module augmentation that lets the global `fetch` (which is
 * undici.fetch under Node ≥ 18) accept our `dispatcher` Agent.
 *
 * Why a global `.d.ts`: undici ships its own types, and the DOM
 * `RequestInit` does not list `dispatcher`. Augmenting once at the
 * project level keeps the call sites in `httpClient.ts` and `robots.ts`
 * type-safe without scattering `(fetch as any)(...)` casts.
 *
 * Without this, `tsc --noEmit` errors with:
 *   "Object literal may only specify known properties, and 'dispatcher'
 *    does not exist in type 'RequestInit'."
 */
import type { Agent } from 'undici';

declare global {
  interface RequestInit {
    dispatcher?: Agent;
  }
}

export {};
