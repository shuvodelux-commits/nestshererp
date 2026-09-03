import type { NextFunction, Request, Response } from 'express';

/**
 * The four headers a JSON API owes a browser.
 *
 * There is no `helmet` here on purpose. Helmet's value is its CSP and its
 * dozen defaults for HTML responses, and this process serves no HTML — the Vue
 * app comes from its own origin (§6.5). What is left that genuinely applies is
 * short enough to state outright, and stating it outright means a reader can
 * see exactly what the API sends without resolving a dependency's defaults.
 *
 * - **`X-Content-Type-Options: nosniff`** — every response here is JSON, and a
 *   browser that sniffs a stored note or an imported CSV row into HTML is the
 *   one way a reflected value on this API could ever execute.
 * - **`X-Frame-Options: DENY`** — nothing on this API is meant to be framed,
 *   and a framed error page is the start of a clickjacking flow.
 * - **`Referrer-Policy: no-referrer`** — document ids and party ids travel in
 *   paths (`/api/v1/sales/{id}`), and a referrer header leaks them to whatever
 *   a later navigation touches.
 * - **`Strict-Transport-Security`**, only when the request arrived over TLS.
 *   Sent unconditionally it would be a lie on the shop's own LAN, where the
 *   API is reached over plain HTTP by design (§6.5) and pinning HTTPS would
 *   lock the counter out of its own server.
 *
 * Deliberately absent: CSP, which belongs on the origin that serves the app,
 * not on the one that serves JSON to it.
 */
export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.secure || request.headers['x-forwarded-proto'] === 'https') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
