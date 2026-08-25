import html2canvas from 'html2canvas-pro';

/**
 * Getting an invoice off the screen: onto paper, into a file, into WhatsApp
 * (§5.8, D-22, owner decision 2026-08-25).
 *
 * **No PDF library.** Printing is the browser's own print dialog over a print
 * stylesheet, because what a shop does with an invoice is hand it over or
 * photograph it, and the page already holds every figure.
 *
 * - **print** prints the invoice *where it already is*, behind a global print
 *   stylesheet (`design/print.css`). The first version copied the markup into a
 *   new window and pasted the page's stylesheets after it; it printed unstyled,
 *   because a component's `<style scoped>` only matches through the `data-v-…`
 *   attributes its own build stamped, and a fresh window is not that build.
 * - **image** repaints the sheet onto a canvas with `html2canvas-pro`.
 * - **share** hands that JPEG to the phone's share sheet, and falls back to a
 *   download on a desktop that has none.
 *
 * **Why a renderer and not the SVG trick** (owner acceptance, 2026-08-26). The
 * export used to serialise the sheet into an SVG `foreignObject` and draw that
 * — no dependency, and it failed three ways in a row on the owner's screen:
 * Vue leaves its template comments in the DOM and `--` inside a comment is
 * illegal XML, so the document would not parse; and once it did parse, the
 * browser refused to export the canvas at all — "Tainted canvases may not be
 * exported" — because an SVG that carries any remote reference stops being
 * origin-clean, and a full page of theme CSS carries plenty. That is not a bug
 * to be chased rule by rule; the guarantee is missing. `html2canvas-pro` walks
 * the live DOM and paints with canvas primitives, so there is no SVG, no XML
 * and nothing to taint. The `-pro` fork rather than `html2canvas` itself:
 * PrimeVue's theme is written in `oklch()`, which the original cannot parse.
 */

export function printNode(node: HTMLElement, template: 'A4' | 'THERMAL_80'): void {
  const body = document.body;
  const hadId = node.id;
  node.id = 'invoice-print-root';
  body.classList.add('printing-document', template === 'A4' ? 'printing-a4' : 'printing-80');

  const done = (): void => {
    body.classList.remove('printing-document', 'printing-a4', 'printing-80');
    node.id = hadId;
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);

  // A tick for the layout to settle under the print rules before the dialog
  // opens; some browsers snapshot immediately.
  window.setTimeout(() => {
    window.print();
    // Safari fires no `afterprint` reliably, so the classes come off anyway.
    window.setTimeout(done, 1000);
  }, 60);
}

/**
 * The sheet as a JPEG blob.
 *
 * Drawn at twice its size, so a receipt that is forwarded on WhatsApp and then
 * photographed off someone's screen is still readable. White behind it, because
 * a JPEG has no transparency and the alternative is a black sheet.
 *
 * A blob, not a `data:` URL: an A4 sheet at double scale is a two-to-four
 * megabyte JPEG, and a browser that quietly refuses a `data:` download that
 * large leaves a button that appears to do nothing.
 */
async function nodeToJpeg(node: HTMLElement): Promise<Blob> {
  const rendered = await html2canvas(node, {
    scale: 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
  });

  /*
   * Onto a white sheet before it becomes a JPEG. A JPEG has no transparency, so
   * any pixel the renderer left untouched — the rounding at the right and
   * bottom edges — is written out as black, and a black rim down the side of an
   * invoice reads as damage (owner-reported, 2026-08-26).
   */
  const canvas = document.createElement('canvas');
  canvas.width = rendered.width;
  canvas.height = rendered.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser cannot draw the invoice');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(rendered, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('The picture came out empty'));
        else resolve(blob);
      },
      'image/jpeg',
      0.92,
    );
  });
}

/**
 * Hand the file over.
 *
 * The object URL is revoked on a later tick, not immediately: the click only
 * *starts* the download, and revoking in the same turn cancels it in some
 * browsers.
 */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

export async function saveNodeAsImage(node: HTMLElement, filename: string): Promise<void> {
  download(await nodeToJpeg(node), filename);
}

export async function shareNodeAsImage(node: HTMLElement, filename: string): Promise<void> {
  const blob = await nodeToJpeg(node);
  const file = new File([blob], filename, { type: 'image/jpeg' });

  const sharer = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };

  if (sharer.share !== undefined && sharer.canShare?.({ files: [file] }) === true) {
    await sharer.share({ files: [file], title: filename });
    return;
  }
  // A desktop browser with no share sheet: the file is downloaded, ready to
  // drop into WhatsApp Web.
  download(blob, filename);
}
