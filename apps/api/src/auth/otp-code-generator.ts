import { randomInt } from 'node:crypto';

import type { OtpCodeGenerator } from '@sher/core-application';
import { OTP_LENGTH } from '@sher/core-application';

const UPPER_BOUND = 10 ** OTP_LENGTH;

/**
 * `randomInt` is cryptographically strong and rejection-samples internally, so
 * every code in the range is equally likely. `Math.random()` here would make a
 * signup code predictable from the clock, which is a free account.
 *
 * Padded, so `000123` stays six digits — a code that is sometimes five
 * characters long is a code the user mistypes.
 */
export class CryptoOtpCodeGenerator implements OtpCodeGenerator {
  generate(): string {
    return String(randomInt(0, UPPER_BOUND)).padStart(OTP_LENGTH, '0');
  }
}
