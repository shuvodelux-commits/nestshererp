import type {
  ImportPreviewResponse,
  ImportResultResponse,
  ImportTypeValue,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * The guided onboarding import (§5.6).
 *
 * The file travels as text: the browser reads what the shopkeeper chose and
 * sends the same string to both calls, so the file that was previewed is
 * exactly the file that posts.
 */
export function previewImport(
  token: string,
  type: ImportTypeValue,
  csv: string,
): Promise<ImportPreviewResponse> {
  return request('/api/v1/imports/preview', { method: 'POST', token, body: { type, csv } });
}

/** `idempotencyKey` is the import operation id, generated once per file (UI-34). */
export function commitImport(
  token: string,
  type: ImportTypeValue,
  csv: string,
  idempotencyKey: string,
): Promise<ImportResultResponse> {
  return request('/api/v1/imports', {
    method: 'POST',
    token,
    body: { type, csv },
    idempotencyKey,
  });
}
