import { Injectable } from '@nestjs/common';

/**
 * The ring buffer the management agent drains (§7, §22).
 *
 * **There is no message field, and that is the design.** The obvious way to
 * ship diagnostics is to send the error text and strip secrets from it on the
 * way out; that approach fails the first time a message interpolates something
 * nobody predicted — a customer's name, a price, a token in a URL — and it
 * fails silently, on the vendor's server, permanently. So this holds a stable
 * code, the module, the route *pattern*, the status, a correlation id and the
 * versions. There is nowhere for free text to go, which means no redaction list
 * to maintain and no way to be one pattern behind.
 *
 * **It lives in memory, bounded, and is lost on restart.** Deliberately: a
 * diagnostics table in the shop's own database would travel inside their
 * `.sherdb` archive and cross the privacy boundary §22 draws, and a file would
 * be one more thing to grow without limit on a counter PC. Losing the buffer on
 * restart costs the vendor the errors from the minutes before a crash, which
 * the crash itself already reported.
 */
const MAX_EVENTS = 500;

export interface BufferedDiagnostic {
  readonly code: string;
  readonly module: string;
  readonly route: string;
  readonly http_status: number;
  readonly correlation_id: string;
  readonly app_version: string;
  readonly schema_version: string;
  readonly occurred_at: string;
  count: number;
}

@Injectable()
export class DiagnosticsBuffer {
  private events: BufferedDiagnostic[] = [];

  /**
   * Records one failure.
   *
   * Identical failures — same code, same route — collapse into a count rather
   * than becoming five hundred rows. A broken afternoon and a broken document
   * are different problems, and the count is what distinguishes them without
   * storing either one's details.
   */
  record(event: Omit<BufferedDiagnostic, 'count'>): void {
    const existing = this.events.find(
      (candidate) => candidate.code === event.code && candidate.route === event.route,
    );
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    this.events.push({ ...event, count: 1 });
    // Oldest out. For fleet monitoring the newest state is what matters; a
    // three-week-old error from a machine that has since been updated is not
    // worth the disk it would take.
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }

  /** Takes everything and empties the buffer — the agent is now holding it. */
  drain(): BufferedDiagnostic[] {
    const taken = this.events;
    this.events = [];
    return taken;
  }

  /** Code → count, for the heartbeat's summary line. */
  counters(): Record<string, number> {
    const counters: Record<string, number> = {};
    for (const event of this.events) {
      counters[event.code] = (counters[event.code] ?? 0) + event.count;
    }
    return counters;
  }
}

/**
 * The single shared buffer.
 *
 * A module-level instance rather than a purely injected one because
 * `AppErrorFilter` is constructed by hand in `main.ts`, before the Nest
 * container exists, and the filter is the one place every failure passes
 * through. Two buffers — one for the filter, one for the controller — would
 * mean the agent draining an empty one forever.
 */
export const diagnosticsBuffer = new DiagnosticsBuffer();
