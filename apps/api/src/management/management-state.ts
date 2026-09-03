import { Injectable } from '@nestjs/common';

/**
 * Two facts about this installation that only the management agent can tell it:
 * which feature flags the vendor has set, and whether a support session is live.
 *
 * **Held in memory, and enabled by default.** §19 and §20: if the control plane
 * is unreachable, or the sidecar is not running, or this process has just
 * restarted and has not been told anything yet, every flag resolves to
 * *enabled*. A vendor outage must never be able to switch a customer's features
 * off — the failure mode of a management channel has to be "no management", not
 * "less ERP".
 *
 * The support session is here for one reason: so the shop's own screens can
 * show a small indicator while the vendor is inside (§15). It is not a
 * permission and grants nothing; the authority is the signed grant on each
 * request, checked in `support.guard.ts`.
 */
export interface ActiveSupportSession {
  readonly session_id: string;
  readonly operator_name: string;
  readonly reason: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

@Injectable()
export class ManagementState {
  private flags = new Map<string, boolean>();
  private support: ActiveSupportSession | null = null;

  setFlags(flags: readonly { key: string; enabled: boolean }[]): void {
    this.flags = new Map(flags.map((flag) => [flag.key, flag.enabled]));
  }

  /** Unknown, unset or never delivered all mean enabled. See the note above. */
  isEnabled(key: string): boolean {
    return this.flags.get(key) ?? true;
  }

  listFlags(): { key: string; enabled: boolean }[] {
    return [...this.flags.entries()].map(([key, enabled]) => ({ key, enabled }));
  }

  /**
   * The installation's own timezone, cached from the management status call.
   *
   * Held here because a support session needs it to compute business dates and
   * the guard that opens one has no database access. Null until the sidecar has
   * asked for status once, which is why an unprepared installation refuses a
   * support session rather than guessing — see `support-grant.ts`.
   */
  private timezone: string | null = null;

  setInstallationTimezone(timezone: string): void {
    this.timezone = timezone;
  }

  installationTimezone(): string | null {
    return this.timezone;
  }

  setSupportSession(session: ActiveSupportSession | null): void {
    this.support = session;
  }

  /**
   * The live session, if it has not run out.
   *
   * Checked against the clock rather than trusted, so a sidecar that died
   * mid-session cannot leave the indicator showing forever — the grant would
   * have expired anyway, and the shop should not be told the vendor is in when
   * they are not.
   */
  supportSession(now: Date): ActiveSupportSession | null {
    if (this.support === null) return null;
    if (Date.parse(this.support.expires_at) <= now.getTime()) {
      this.support = null;
      return null;
    }
    return this.support;
  }
}

/** The single shared instance, for the same reason the diagnostics buffer has one. */
export const managementState = new ManagementState();
