/**
 * Cryptographically random 6-digit OTP codes (D-07).
 *
 * A port for the same reason `Clock` is one: randomness is ambient I/O, and a
 * pure use case cannot reach for it and stay testable. `Math.random()` is not an
 * acceptable implementation — a guessable signup code is a free account.
 */
export interface OtpCodeGenerator {
  generate(): string;
}
