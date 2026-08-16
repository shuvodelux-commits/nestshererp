import { Logger } from '@nestjs/common';
import type { IdentityVerifier, OtpDelivery } from '@sher/core-application';
import type { IdentifierChannel } from '@sher/core-application';

/**
 * The development transport for D-33's `IdentityVerifier`, and the only one
 * slice 1.1 ships. It sends nothing: it logs that a code was issued and hands
 * the code back so registration is testable without a paid SMS gateway.
 *
 * `OtpIdentityVerifier` (real SMS/email) and `NoOpIdentityVerifier` (on-premise)
 * arrive with the rest of D-33 in slice 1.7, together with the boot validation
 * that refuses to start with the wrong combination.
 *
 * **This must never be wired in production.** `PersistenceModule` selects it
 * only when `NODE_ENV !== 'production'`, and boot fails loudly otherwise rather
 * than silently accepting any code a caller invents.
 */
export class DevIdentityVerifier implements IdentityVerifier {
  private readonly logger = new Logger(DevIdentityVerifier.name);

  async sendOtp(
    identifier: string,
    channel: IdentifierChannel,
    code: string,
  ): Promise<OtpDelivery> {
    // The code is echoed to the developer running the stack, which is the whole
    // point of this transport. A real one never logs the code (§5.3).
    this.logger.log(`DEV OTP for ${channel} ${identifier}: ${code}`);
    return Promise.resolve({ devCode: code });
  }
}
