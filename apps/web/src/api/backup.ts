import type {
  ArchivePreviewResponse,
  BackupStatusResponse,
  ResetResultResponse,
  RestoreResultResponse,
} from '@sher/core-contracts';

import { loadConfig, request } from './client';

/**
 * Backup, restore and reset (Phase 10, §5.25).
 *
 * The backup secret is never sent to the browser and never comes back from any
 * of these calls. What travels is the caller's own password for step-up, and
 * the archive bytes.
 */
export function fetchBackupStatus(token: string): Promise<BackupStatusResponse> {
  return request('/api/v1/backup/status', { token });
}

/**
 * The archive itself.
 *
 * Handled outside `request` because the response is not JSON — it is the file.
 * `Content-Disposition` carries the name the server chose, and the caller hands
 * the blob straight to the browser's download.
 */
export async function downloadBackup(
  token: string,
  confirmPassword: string,
): Promise<{ fileName: string; blob: Blob }> {
  const { apiBaseUrl } = await loadConfig();
  const response = await fetch(`${apiBaseUrl}/api/v1/backup/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirmPassword }),
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(problem?.message ?? 'The backup could not be created.');
  }

  return {
    fileName: fileNameFrom(response.headers.get('Content-Disposition')),
    blob: await response.blob(),
  };
}

export function inspectArchive(
  token: string,
  fileName: string,
  contentBase64: string,
): Promise<ArchivePreviewResponse> {
  return request('/api/v1/backup/inspect', {
    token,
    method: 'POST',
    body: { fileName, contentBase64 },
    envelope: true,
  });
}

export function restoreArchive(
  token: string,
  fileName: string,
  contentBase64: string,
  confirmPassword: string,
): Promise<RestoreResultResponse> {
  return request('/api/v1/backup/restore', {
    token,
    method: 'POST',
    body: { fileName, contentBase64, confirmPassword },
    envelope: true,
  });
}

export function resetBusiness(
  token: string,
  confirmPassword: string,
  confirmPhrase: string,
): Promise<ResetResultResponse> {
  return request('/api/v1/backup/reset', {
    token,
    method: 'POST',
    body: { confirmPassword, confirmPhrase },
    envelope: true,
  });
}

export function replaceBackupSecret(
  token: string,
  confirmPassword: string,
  newSecret: string,
): Promise<{ configured: true }> {
  return request('/api/v1/backup/secret', {
    token,
    method: 'POST',
    body: { confirmPassword, newSecret },
    envelope: true,
  });
}

function fileNameFrom(header: string | null): string {
  const match = header === null ? null : /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? 'sher-backup.sherdb';
}
