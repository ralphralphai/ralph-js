'use client';

// `GlobalTracker` uses hooks, so it has to sit behind a client boundary. It is a
// separate entry point rather than part of `./index` so that a Server Component
// can import `TrackedButton` and the `data-track-id` constants (neither of which
// uses hooks) without pulling a client boundary in with them.

export { GlobalTracker } from '@/GlobalTracker';
