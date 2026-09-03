import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bounded local queue (§21, owner decision 2026-09-03).
 *
 * A shop with no line does not stop trading, and the sidecar does not stop
 * noticing things. What it must not do is grow without bound on a counter PC
 * with a small disk, so the queue holds a fixed number of entries and **drops
 * the oldest** when it is full.
 *
 * Oldest-first is the right sacrifice for fleet monitoring specifically. The
 * newest state is what tells the vendor whether the shop is all right now; the
 * hundredth-oldest error from three weeks ago tells them about a machine that
 * has since been through an update. Dropping newest — the other obvious choice —
 * would mean a long outage ends with the vendor holding only stale news.
 *
 * **It lives in the sidecar's own directory, never the shop's database.** §22:
 * vendor telemetry inside customer business data would travel in their
 * `.sherdb` archive and cross a boundary that is meant to be one-way.
 */
const MAX_ENTRIES = 500;

export class LocalQueue<T> {
  private readonly path: string;

  constructor(stateDir: string, name: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.path = join(stateDir, `${name}.json`);
  }

  read(): T[] {
    if (!existsSync(this.path)) return [];
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T[];
    } catch {
      // A truncated file — a power cut mid-write — costs the queue, not the
      // process. Telemetry is not worth refusing to start over.
      return [];
    }
  }

  push(entry: T): void {
    const entries = this.read();
    entries.push(entry);
    this.write(entries.slice(-MAX_ENTRIES));
  }

  /** Takes up to `count` oldest entries, leaving them until `commit` succeeds. */
  peek(count: number): T[] {
    return this.read().slice(0, count);
  }

  /** Drops the first `count` entries once the far end has acknowledged them. */
  commit(count: number): void {
    this.write(this.read().slice(count));
  }

  get length(): number {
    return this.read().length;
  }

  private write(entries: T[]): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    // Rename rather than overwrite: a crash mid-write leaves the previous
    // queue intact rather than a half-written one.
    renameSync(temporary, this.path);
  }
}

/**
 * Exponential backoff, 1 minute to 30 minutes.
 *
 * The lower bound stops a shop hammering a control plane that is down; the
 * upper bound stops a shop that came back at 9am from being invisible until
 * lunchtime. Jitter keeps a fleet that all lost the same upstream from
 * reconnecting in one wave.
 */
export function backoffSeconds(failures: number): number {
  const base = Math.min(60 * 2 ** Math.min(failures, 5), 30 * 60);
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}
