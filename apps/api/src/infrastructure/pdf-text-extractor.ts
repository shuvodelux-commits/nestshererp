import type { StatementExtractor } from '@sher/core-application';

/**
 * Text out of a PDF, using pdf.js (§5.17, Phase 11).
 *
 * **Here and not in a package**, because pdf.js is a Node/browser library and
 * `core-domain` must stay pure — the rule that keeps `parseStatement` testable
 * with a handful of strings instead of a fixture PDF. This file's whole job is
 * bytes in, text lines out; it knows nothing about statements, banks or money.
 *
 * **Rows, not words.** pdf.js returns each text run with its position, and a
 * statement's date, description, amount and balance are four separate runs on
 * one visual line. They are regrouped here by their vertical position, left to
 * right, so what the parser reads is what a person sees on the page.
 */

interface PdfTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
}

interface PdfPage {
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/** Releasing the worker is the **task's** job, not the document's. */
interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
}

/**
 * What the port returns, written out rather than imported: `apps/api` depends
 * on `core-application`, not on `core-domain`, and this shape is the whole
 * contract between the two.
 */
interface ExtractedTextLine {
  readonly page: number;
  readonly y: number;
  readonly text: string;
}

/** Runs closer together than this vertically are the same visual line. */
const LINE_TOLERANCE = 2;

export class PdfTextExtractor implements StatementExtractor {
  private module: PdfJsModule | null = null;

  async extract(content: Uint8Array): Promise<readonly ExtractedTextLine[]> {
    const pdfjs = await this.load();

    // `isEvalSupported: false` keeps the font-loading path from compiling
    // anything at runtime, which is not a thing a server should do to bytes a
    // customer uploaded.
    /*
     * **A copy, not the caller's bytes.** pdf.js takes ownership of the array
     * it is handed and transfers it to its worker, which leaves the original
     * detached and zero-length. The caller still needs those bytes — the file
     * is the evidence a reconciliation rests on (§5.17) — and handing them over
     * stored an empty statement until this copy was added.
     */
    const task = pdfjs.getDocument({
      data: new Uint8Array(content),
      isEvalSupported: false,
      useSystemFonts: false,
      // A statement is a text document; drawing it is not our business, and a
      // missing font must never be the reason an upload fails.
      disableFontFace: true,
    });

    const document = await task.promise;
    const lines: ExtractedTextLine[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const text = await page.getTextContent();
        lines.push(...groupIntoLines(pageNumber, text.items as readonly PdfTextItem[]));
      }
    } finally {
      await task.destroy();
    }

    return lines;
  }

  /**
   * pdf.js ships as ES modules and the API compiles to CommonJS, so it is
   * loaded through a dynamic `import()` — the one form that works across that
   * boundary — and only when a statement is actually uploaded. The module is
   * kept afterwards: it is several megabytes of parser and the second upload
   * should not pay for it again.
   */
  private async load(): Promise<PdfJsModule> {
    this.module ??= (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
    return this.module;
  }
}

/** Text runs sharing a baseline, joined left to right, top of the page first. */
function groupIntoLines(
  page: number,
  items: readonly PdfTextItem[],
): readonly ExtractedTextLine[] {
  const positioned = items
    .map((item) => ({
      text: item.str ?? '',
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
    }))
    .filter((item) => item.text.trim() !== '');

  const rows: { y: number; parts: { x: number; text: string }[] }[] = [];

  for (const item of positioned) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= LINE_TOLERANCE);
    if (row === undefined) rows.push({ y: item.y, parts: [{ x: item.x, text: item.text }] });
    else row.parts.push({ x: item.x, text: item.text });
  }

  return rows
    // A PDF's y axis counts up from the bottom of the page, so the largest y is
    // the top line — the reverse of reading order.
    .sort((a, b) => b.y - a.y)
    .map((row) => ({
      page,
      y: row.y,
      text: row.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((line) => line.text !== '');
}
