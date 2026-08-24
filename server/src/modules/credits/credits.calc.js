/**
 * Credit calculation. Pure functions, no database, no provider.
 *
 * Separate from credits.service.js because everything here is arithmetic that
 * both the server and (mirrored) the client need to agree on, and because a
 * pricing rule with no I/O in it is a pricing rule that can be read and checked
 * at a glance.
 */

/**
 * Characters and UTF-8 bytes for a piece of text.
 *
 * They are different numbers and they answer different questions:
 *
 *   charCount  - what we charge for. 1 credit = 1 character (DECISIONS.md).
 *   byteLength - what Google limits. Its synthesize endpoint caps the request
 *                payload, and the cap is in bytes.
 *
 * For "café" those are 4 and 5. For an emoji they are 2 and 4. Charging by bytes
 * would mean a Hindi user pays three times what an English user pays for the
 * same sentence, which is not a pricing model anyone would choose on purpose.
 *
 * Note String.length is UTF-16 code units, so an emoji counts as 2. Counting
 * grapheme clusters would be more correct and would also mean the number the
 * client shows and the number the server charges could disagree; both sides run
 * String.length, so they never do.
 */
export function countText(text) {
  return {
    charCount: text.length,
    byteLength: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * What a generation will cost, before it runs.
 *
 * The multiplier comes off the Voice document. It is never a rate from a price
 * list compiled into this file - see DECISIONS.md §1 and the comment on
 * Voice.costMultiplier. Every voice ships at 1 until the pricing step calibrates
 * them, so today this returns the character count.
 *
 * Rounded up, because a fractional credit cannot be stored and rounding down
 * would make a long generation free at a low enough multiplier.
 */
export function quote({ text, voice }) {
  const { charCount, byteLength } = countText(text);
  const multiplier = voice?.costMultiplier ?? 1;

  return {
    charCount,
    byteLength,
    credits: Math.max(1, Math.ceil(charCount * multiplier)),
  };
}
