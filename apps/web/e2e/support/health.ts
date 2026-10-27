import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

/**
 * What a browser complains about while a spec drives it (§14 of the owner's
 * acceptance-test request, 2026-09-03).
 *
 * **A page that renders and throws is a page that looks fine in a screenshot
 * and is broken.** Playwright will happily click through a screen whose Vue
 * component died in a watcher, whose request came back 500, or whose template
 * threw on a null — the click lands, the assertion about the heading passes,
 * and the defect ships. Attaching this to a page turns all of that into a
 * failure, which is the difference between testing that a screen exists and
 * testing that it works.
 *
 * **Everything is allow-listed by exception, never by pattern.** A test that
 * needs an error — a validation refusal, a deliberate 404 — says so, and
 * anything it did not ask for fails. The opposite arrangement, ignoring errors
 * that "look expected", is how a suite ends up green beside a console full of
 * red.
 */

export interface HealthReport {
  readonly problems: readonly string[];
}

export interface HealthOptions {
  /**
   * Status codes this spec deliberately provokes, as `METHOD /path` prefixes.
   * A refusal a test is *about* is not a browser-health failure.
   */
  readonly expectFailedRequests?: readonly string[];
  /** Console text this spec deliberately provokes. */
  readonly expectConsole?: readonly RegExp[];
}

/**
 * Noise this application makes that says nothing about the screen under test.
 *
 * Kept short and each entry argued, because every line here is a class of real
 * defect the suite stops seeing. Both entries are the browser talking about
 * itself rather than about SherERP.
 */
const IGNORED_CONSOLE: readonly RegExp[] = [
  // Chromium's own devtools/extension chatter on a fresh profile.
  /Download the (React|Vue) DevTools/i,
  // A favicon a test profile has no reason to carry.
  /favicon\.ico/i,
];

/**
 * Requests that fail for reasons outside the application.
 *
 * `/config.json` is fetched optimistically at boot and its absence is a
 * supported deployment (the app falls back to same-origin `/api`), so a 404
 * there is configuration, not breakage.
 */
const IGNORED_REQUESTS: readonly RegExp[] = [/\/config\.json$/, /\/favicon\.ico$/];

export function watchHealth(page: Page, options: HealthOptions = {}): HealthReport {
  const problems: string[] = [];
  const expectedRequests = options.expectFailedRequests ?? [];
  const expectedConsole = options.expectConsole ?? [];

  const consoleExpected = (text: string): boolean =>
    IGNORED_CONSOLE.some((pattern) => pattern.test(text)) ||
    expectedConsole.some((pattern) => pattern.test(text));

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (consoleExpected(text)) return;
    // Warnings are included because Vue reports a failed render, an unknown prop
    // and a broken key as warnings, and each of those is a real defect.
    if (message.type() === 'warning' && !/vue|\[Vue warn\]/i.test(text)) return;
    problems.push(`console.${message.type()}: ${text}`);
  });

  page.on('pageerror', (error: Error) => {
    // An uncaught exception is never acceptable, so this has no allow-list.
    problems.push(`uncaught: ${error.message}`);
  });

  page.on('requestfailed', (request: Request) => {
    const url = request.url();
    if (IGNORED_REQUESTS.some((pattern) => pattern.test(url))) return;
    problems.push(`request failed: ${request.method()} ${url} — ${request.failure()?.errorText ?? ''}`);
  });

  page.on('response', (response: Response) => {
    const status = response.status();
    if (status < 400) return;
    const url = new URL(response.url());
    if (IGNORED_REQUESTS.some((pattern) => pattern.test(url.pathname))) return;
    const signature = `${response.request().method()} ${url.pathname}`;
    if (expectedRequests.some((prefix) => signature.startsWith(prefix))) return;
    problems.push(`${String(status)} from ${signature}`);
  });

  return {
    get problems() {
      return [...problems];
    },
  };
}
