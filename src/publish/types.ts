// Contract: call saveHandle before any request that could create a post, and on every call
// use `handle` first to find out what already happened. No handle must mean nothing was
// posted. Pass `signal` to every fetch.
export interface Publisher {
  platform: string;
  publish(input: {
    filePath: string;
    title: string;
    caption: string;
    aiDisclosure: boolean;
    visibility: 'public' | 'private';
    idempotencyKey: string; // `${slotId}:${platform}`, stable across retries
    handle: unknown | null;
    saveHandle(h: unknown): void;
    signal: AbortSignal;
  }): Promise<{ postId: string; postUrl: string | null }>;
}

// Safe to try again later.
export class RetryableError extends Error {}
// Will never succeed; skip.
export class PermanentError extends Error {}
// Outcome unknown (may have posted); a human decides.
export class AmbiguousError extends Error {}
// Another process re-claimed this publication; stop without writing.
export class ClaimLostError extends Error {}
