/**
 * What the interface remembers about itself, between launches.
 *
 * Not `localStorage`, which cannot do this job here. The control plane binds
 * port 0 — the operating system picks a free one — so the page is served from
 * `http://127.0.0.1:<a different port>` every launch, and `localStorage` is
 * scoped to an origin. Every preference was silently forgotten each time: the
 * introduction came back however carefully it had been finished, the rail
 * re-expanded, the theme reset, folded categories unfolded.
 *
 * So the control plane holds them, and this module is the whole client:
 * hydrated once before the first render, read synchronously after that (the
 * stores that use it initialise during module evaluation and cannot await), and
 * written through on change.
 *
 * `localStorage` is still written, as a cache and nothing more. It makes the
 * *first* paint of a reopened window right when hydration is still in flight,
 * and it is what remembers on the one origin that is stable — a browser pointed
 * at a long-lived `ssh-manager control`.
 */
import { url } from '@/lib/api';

/** @internal Exported for the hydration step only. */
let cache: Record<string, string> = {};

/**
 * Fill the cache from the control plane. Call once, before rendering.
 *
 * Failure is not an error worth showing: preferences are a convenience, and a
 * control plane that cannot answer has bigger problems than a folded category.
 */
export async function hydratePreferences(): Promise<void> {
  try {
    const response = await fetch(url('/api/preferences'));
    if (!response.ok) return;
    const { preferences } = await response.json();
    if (preferences && typeof preferences === 'object') {
      cache = { ...cache, ...preferences };
      for (const [key, value] of Object.entries(cache)) {
        try { localStorage.setItem(key, String(value)); } catch { /* see readPreference */ }
      }
    }
  } catch {
    // Offline, or the token expired. Whatever localStorage holds still stands.
  }
}

/**
 * Read a preference. Synchronous, because the stores that need it build their
 * initial state at import time.
 *
 * @param key - Storage key, kept identical to the old localStorage key so an
 *   existing browser profile carries its settings over rather than resetting.
 */
export function readPreference(key: string): string | null {
  if (key in cache) return cache[key];
  try {
    // Reading storage can throw outright in a locked-down context.
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a preference to the control plane, and to the cache in front of it. */
export function writePreference(key: string, value: string): void {
  cache[key] = value;
  try { localStorage.setItem(key, value); } catch { /* see readPreference */ }
  void fetch(url('/api/preferences'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {
    // A preference that could not be saved is still a preference for this
    // session — the cache above already holds it.
  });
}
