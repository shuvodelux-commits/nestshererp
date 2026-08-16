/**
 * Password and PIN hashing (§5.3).
 *
 * A port because hashing needs `node:crypto`, which this package may not import
 * — it is bundled for the browser in Phase 12. The implementation chooses the
 * algorithm and parameters; nothing above this line knows or cares which.
 *
 * `verify` must compare in constant time. A plaintext password or PIN never
 * leaves the use case that received it, and is never stored, logged or audited.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
