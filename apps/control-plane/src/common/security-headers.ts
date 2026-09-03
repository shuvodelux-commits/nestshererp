import type { NextFunction, Request, Response } from 'express';

/**
 * Headers on every control-plane response.
 *
 * `DENY` rather than `SAMEORIGIN`: this console can open a customer's ERP and
 * revoke a licence, so it must never be embeddable anywhere, by anyone. The
 * *other* direction — the customer's ERP being embedded inside this console
 * during a support session — is handled at the support gateway, which rewrites
 * that one response's frame headers for that one session's origin. See
 * `support/gateway.ts`; the exception is narrow on purpose, and does not touch
 * the header a shop's own users receive.
 */
export function controlSecurityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
