/**
 * The bytes that get signed, and how both sides reproduce them.
 *
 * This is the same discipline `packages/core-contracts/src/license-key.ts`
 * already applies to a licence key, for the same reason: **a signature over
 * "whatever text arrived" is not a signature over anything.** If the verifier
 * hashes the received bytes and the signer hashed its own serialisation, the
 * two agree only by luck — a re-ordered key, an extra space, a number written
 * `1.0` instead of `1` and the check fails on a message nobody tampered with.
 * Worse, the reverse: a parser that is more forgiving than the canonicaliser
 * lets an attacker append a field the verifier ignores but the executor obeys.
 *
 * So: parse first, canonicalise from the parsed value, sign and verify that.
 * No crypto lives in this file — it is imported by a browser dashboard as well
 * as by two Node processes, and the platform provides different primitives to
 * each. What must not differ between them is this function.
 */

/** A value that can appear in a canonical document. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Deterministic JSON: object keys sorted by code unit, no whitespace,
 * `undefined` members dropped rather than emitted as null.
 *
 * Sorting rather than a hand-written key order (which is what the licence
 * payload does) because these documents carry an open-ended `payload` object
 * whose shape depends on the command type — there is no single list of keys to
 * write down, so the order has to be derivable instead.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Format markers, and the first segment of every signed blob on this channel.
 *
 * They are inside the signed bytes, never merely alongside them. A signature
 * that covers only the payload can be lifted from one kind of message and
 * replayed as another the day a second message type is added; binding the
 * marker means a command signature can never be presented as a check-in
 * signature, whatever the two happen to contain.
 */
export const COMMAND_ENVELOPE_PREFIX = 'SHERCMD1';
export const AGENT_REQUEST_PREFIX = 'SHERAGT1';
export const SUPPORT_GRANT_PREFIX = 'SHERSUP1';
export const RELEASE_MANIFEST_PREFIX = 'SHERREL1';
