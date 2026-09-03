/**
 * A tag reader for Vue templates (owner request 2026-09-03).
 *
 * **Why this exists rather than a regex per pattern.** The first version of this
 * tool matched `<button[^>]*>` and it was wrong on the busiest screen in the
 * product: `<button v-if="drafts.length > 0">` contains a `>` inside an
 * attribute, so the match ended in the middle of the tag and the POS reported
 * button labels like `0" type="button" class="scanbar__drafts"`. A test matrix
 * that misreads the till is worse than no matrix, so the scanner reads tags the
 * way a parser does — quote-aware — and keeps the nesting, which is what tells
 * a row action inside a `<td>` apart from the screen's own Save button.
 *
 * It is still not a Vue compiler and does not try to be. It knows tags,
 * attributes and nesting; it does not know directives, slots or scope.
 */

export interface Tag {
  readonly name: string;
  readonly kind: 'OPEN' | 'CLOSE' | 'SELF';
  readonly attrs: ReadonlyMap<string, string>;
  readonly start: number;
  readonly end: number;
  /** Open tags of the elements this one sits inside, outermost first. */
  readonly ancestors: readonly string[];
}

function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /([@:#]?[A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of raw.matchAll(pattern)) {
    const name = (match[1] ?? '').replace(/^:/, '');
    if (name === '') continue;
    out.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

export function tokenize(template: string): readonly Tag[] {
  const out: Tag[] = [];
  const stack: string[] = [];
  // Elements that never carry a closing tag; leaving them on the stack would
  // make every following control look like a child of the last text box.
  const VOID = new Set(['input', 'br', 'hr', 'img', 'source', 'meta', 'link', 'col']);

  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('<', index);
    if (open === -1) break;
    if (template.startsWith('<!--', open)) {
      index = template.indexOf('-->', open) + 3 || template.length;
      continue;
    }

    const nameMatch = /^<\/?([A-Za-z][\w.-]*)/.exec(template.slice(open, open + 80));
    if (nameMatch === null) {
      index = open + 1;
      continue;
    }

    // Walk to the closing `>` while respecting quotes, which is the whole point.
    let cursor = open + nameMatch[0].length;
    let quote: string | null = null;
    while (cursor < template.length) {
      const char = template[cursor];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      cursor += 1;
    }

    const raw = template.slice(open, cursor + 1);
    const name = nameMatch[1] ?? '';
    const closing = raw.startsWith('</');
    const self = raw.endsWith('/>') || VOID.has(name.toLowerCase());

    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
      out.push({ name, kind: 'CLOSE', attrs: new Map(), start: open, end: cursor, ancestors: [...stack] });
    } else {
      const attrs = parseAttrs(template.slice(open + nameMatch[0].length, cursor));
      out.push({
        name,
        kind: self ? 'SELF' : 'OPEN',
        attrs,
        start: open,
        end: cursor,
        ancestors: [...stack],
      });
      if (!self) stack.push(name);
    }
    index = cursor + 1;
  }
  return out;
}

/** The text an element contains, tags removed — what a person reads on it. */
export function textOf(template: string, tags: readonly Tag[], at: number): string {
  const open = tags[at];
  if (open === undefined) return '';
  let depth = 0;
  for (let index = at + 1; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag === undefined) continue;
    if (tag.name === open.name) {
      if (tag.kind === 'OPEN') depth += 1;
      else if (tag.kind === 'CLOSE') {
        if (depth === 0) return template.slice(open.end + 1, tag.start);
        depth -= 1;
      }
    }
  }
  return '';
}
