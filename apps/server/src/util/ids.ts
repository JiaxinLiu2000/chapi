import { customAlphabet } from 'nanoid';

// URL-friendly short id for session slugs.
const slugId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

/** Short collision-resistant token, e.g. to disambiguate same-named uploads. */
export function shortId(size = 6): string {
  return slugId().slice(0, size);
}

/** Derive a readable slug from a first message + a short unique suffix. */
export function makeSessionSlug(seed?: string): string {
  const base = (seed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 40);
  const suffix = slugId().slice(0, 6);
  return base ? `${base}-${suffix}` : suffix;
}

/** Derive a session title from the first message. */
export function deriveTitle(firstMessage?: string): string {
  if (!firstMessage) return 'New session';
  const t = firstMessage.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || 'New session';
}
