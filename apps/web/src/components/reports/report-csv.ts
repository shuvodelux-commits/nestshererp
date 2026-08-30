import { toCsv } from '@sher/core-domain';

/**
 * A report as displayed, downloadable (owner decision 2026-08-30).
 *
 * It reuses `toCsv` from the domain — the same writer the guided importer's
 * template uses — so a file the shop opens in Excel quotes and escapes exactly
 * the way the file it uploads is expected to. One CSV rule in the product, not
 * two that nearly agree.
 *
 * The download is a blob URL rather than a server endpoint: the rows are
 * already on the screen, and asking the server to compute them a second time
 * would be a second chance for the two to differ.
 */
export function downloadCsv(fileName: string, rows: readonly (readonly string[])[]): void {
  const blob = new Blob([toCsv(rows.map((row) => [...row]))], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
