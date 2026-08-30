import type { ExtractedTextLine } from '@sher/core-domain';

/**
 * Getting text out of a PDF (§5.17, Phase 11).
 *
 * A port, because reading a PDF needs a Node library and the layer that decides
 * what a statement *means* must stay pure. The implementation lives in
 * `apps/api/src/infrastructure`; `parseStatement` in `core-domain` turns what it
 * returns into rows and is testable with a handful of strings.
 *
 * **A file it cannot read is not an error.** A scanned image has no text layer,
 * and the answer to that is an empty list — the file is still kept as evidence
 * and the owner reconciles against the paper. Only a corrupt or encrypted file,
 * which is a different thing from an unreadable one, throws.
 */
export interface StatementExtractor {
  extract(content: Uint8Array): Promise<readonly ExtractedTextLine[]>;
}
