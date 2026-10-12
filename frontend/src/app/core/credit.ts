import type { Credit } from './tour.models';

/**
 * One attribution line for either credit variant.
 *
 * Original work has no URL to link, which is the whole reason the union
 * exists; sourced work links back to where it came from.
 */
export function creditLine(credit: Credit): { attribution: string; url: string | null } {
  if (credit.type === 'original') {
    return { attribution: `${credit.creator} · ${credit.license}`, url: null };
  }
  const who = credit.creator ? `${credit.source} — ${credit.creator}` : credit.source;
  return { attribution: `${who} · ${credit.license}`, url: credit.url };
}
