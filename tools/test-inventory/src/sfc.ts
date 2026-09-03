import type { ActionItem, ControlKind, DropdownItem, FieldItem, TableItem } from './model.js';
import { textOf, tokenize } from './tokens.js';
import type { Tag } from './tokens.js';

/**
 * What is on a SherERP screen, read from its single-file component.
 *
 * The two things this has to get right are **which controls exist** and **what
 * a person would call them**, because a semantic selector is how every test in
 * this suite finds anything (owner decision 2026-09-03: roles and visible text,
 * never a class name). This codebase writes fields three ways and all three are
 * read here:
 *
 *  1. `<label for="x">` over a control carrying `id="x"` — the dialog pattern.
 *  2. A `<label>` wrapped around its control — the POS cart pattern.
 *  3. No label at all, named only by its placeholder — the POS customer picker.
 *
 * The third is recorded rather than skipped, and marked `labelled: false`. A
 * control with no accessible name cannot be found by role and name, which makes
 * it both an accessibility defect (§13) and a thing no semantic test can reach —
 * so the matrix has to show it rather than quietly omit it and look complete.
 */

export interface ParsedSfc {
  readonly script: string;
  readonly template: string;
}

export function splitSfc(source: string): ParsedSfc {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';
  const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? '';
  return { script, template };
}

/**
 * The English half of a bilingual label, with any mustache resolved to the
 * text it settles on.
 *
 * Every label reads `English <span>বাংলা</span>` (UI-14) and every busy button
 * reads `{{ busy ? 'Saving…' : 'Save adjustment' }}`. What a test writes in a
 * regex is `Save adjustment` — the resting state, not the one that exists for
 * the half second the request is in flight — so a mustache contributes its last
 * string literal and the ellipsis forms are dropped.
 */
export function labelText(raw: string): string {
  const resolved = raw
    // A template literal names a row: `Actions for ${product.displayName}` is
    // the Actions menu, and the fixed half plus an ellipsis is what the matrix
    // should print — the label is per-row, and saying so is more honest than
    // printing half a sentence.
    .replace(/\$\{[^}]*\}/g, '…')
    .replace(/`/g, '')
    .replace(/\{\{([\s\S]*?)\}\}/g, (_whole, expression: string) => {
    const literals = [...expression.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map((match) => (match[1] ?? '').replace(/\\'/g, "'"))
      .filter((text) => !/[…]|\.\.\.$/.test(text) && text.trim() !== '');
    return literals.length === 0 ? ' ' : literals[literals.length - 1] ?? ' ';
  });
  return resolved
    .replace(/<[^>]*>/g, ' ')
    // Bangla, Bengali digits and their punctuation: kept out of the printed
    // label because a test author writes the English, and shown in full in the
    // component itself for anybody who needs the other half.
    .replace(/[ঀ-৿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim();
}

/**
 * The text a bound attribute settles on.
 *
 * `:aria-label="unpaidOnly ? 'Showing unpaid only' : 'Show unpaid only'"` is a
 * JavaScript expression rather than a string, and printing it verbatim put a
 * ternary in the matrix where a button name belongs. The last literal is the
 * one a person reads in the state they arrive in.
 */
function expressionText(raw: string): string {
  if (!raw.includes(`'`)) return labelText(raw);
  const literals = [...raw.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1] ?? '');
  return labelText(literals[literals.length - 1] ?? raw);
}

const CONTROL_TAGS = new Set([
  'input', 'select', 'textarea',
  'InputText', 'InputNumber', 'Textarea', 'Select', 'MultiSelect', 'Checkbox', 'RadioButton',
  'ToggleSwitch', 'DatePicker', 'AutoComplete', 'Password', 'InputMask',
  'AmountInput', 'DateOnlyPicker', 'ComboField', 'QuickAddSelect', 'MoneyAccountPicker',
  'OtpInput', 'CounterAmountField', 'CounterChoice', 'SearchField',
]);

function handleOf(tag: Tag): string | null {
  return (
    tag.attrs.get('id') ??
    tag.attrs.get('input-id') ??
    tag.attrs.get('inputId') ??
    tag.attrs.get('v-model') ??
    tag.attrs.get('v-model:model-value') ??
    null
  );
}

/**
 * Money and quantity are different types with different boundaries.
 *
 * Money is scale 2 and quantity scale 3; `25.5` is a legal price and `0.0005`
 * is not a legal count of anything. Telling them apart matters more than it
 * looks, because §3 asks for domain-aware boundary cases and a test that feeds
 * price cases to a quantity box proves nothing about either.
 *
 * When the element does not say — `<input inputmode="decimal">` is both — the
 * field's own name decides, and the quantity words win over the money ones.
 * That order is not arbitrary: `stock-amount` on the stock adjustment dialog
 * contains `amount` and holds a count of goods, and reading it as money was the
 * first thing this tool got wrong.
 */
export function controlKind(tag: Tag, handle: string, label: string): ControlKind {
  const name = `${handle} ${label}`.toLowerCase();

  switch (tag.name) {
    case 'AmountInput':
    case 'CounterAmountField':
      return 'MONEY';
    case 'DateOnlyPicker':
    case 'DatePicker':
      return 'DATE';
    case 'Textarea':
      return 'TEXTAREA';
    case 'MultiSelect':
      return 'MULTI_SELECT';
    case 'Checkbox':
      return 'CHECKBOX';
    case 'ToggleSwitch':
      return 'TOGGLE';
    case 'RadioButton':
    case 'CounterChoice':
      return 'RADIO';
    case 'OtpInput':
      return 'OTP';
    case 'InputNumber':
      return 'NUMBER';
    case 'QuickAddSelect':
    case 'ComboField':
    case 'AutoComplete':
    case 'MoneyAccountPicker':
      return 'SEARCHABLE_SELECT';
    case 'SearchField':
      return 'TEXT';
    case 'Select':
    case 'select':
      return tag.attrs.has('filter') ? 'SEARCHABLE_SELECT' : 'SELECT';
    default:
      break;
  }

  const type = tag.attrs.get('type');
  if (type === 'file') return 'FILE';
  if (type === 'checkbox') return 'CHECKBOX';
  if (type === 'radio') return 'RADIO';
  if (type === 'date') return 'DATE';

  const mode = tag.attrs.get('inputmode');
  if (mode === 'decimal' || mode === 'numeric') {
    if (/\bqty|quantity|stock|counted|packs?\b|units?\b|pieces?\b/.test(name)) return 'QUANTITY';
    if (/price|amount|cost|paid|cash|due|discount|total|balance|credit|fee|charge|salary|rent|limit|opening/.test(name)) {
      return 'MONEY';
    }
    return 'NUMBER';
  }
  return 'TEXT';
}

/**
 * Whether the screen refuses to save without this field, and whether that
 * depends on something else on the same screen.
 *
 * Read from the guards that actually raise a validation error, not from any
 * `if` mentioning the field. The difference is real: the stock adjustment
 * dialog tests `businessDate.value === ''` to decide whether to *send* the
 * field — blank means today — and reading that as "required" would have put a
 * required-field test on an optional box and made it fail forever.
 *
 * `CONDITIONAL` is its own answer because several screens genuinely work that
 * way: a note is required only when the reason is `Other`, and a test that
 * demands it unconditionally is testing a rule the product does not have.
 */
export type Requiredness = 'YES' | 'CONDITIONAL' | 'NO';

interface Guard {
  readonly condition: string;
}

/** Every `if (…)` whose body raises a validation error. */
function validationGuards(script: string): readonly Guard[] {
  const out: Guard[] = [];
  const pattern = /if\s*\(([\s\S]{0,300}?)\)\s*\{([\s\S]{0,400}?)\}/g;
  for (const match of script.matchAll(pattern)) {
    const body = match[2] ?? '';
    if (/error\.value\s*=|VALIDATION_FAILED|throw new/.test(body)) {
      out.push({ condition: match[1] ?? '' });
    }
  }
  // The single-line form, which several screens use for the first check.
  const single = /if\s*\(([^)\n]{0,200})\)\s*(?:return\s*)?(?:error\.value\s*=)/g;
  for (const match of script.matchAll(single)) out.push({ condition: match[1] ?? '' });
  return out;
}

function requiredness(script: string, tag: Tag, boundRef: string | null): Requiredness {
  if (tag.attrs.has('required')) return 'YES';
  if (boundRef === null) return 'NO';

  const ref = boundRef.replace(/\.value$/, '').replace(/^[\w.]*\./, '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ref)) return 'NO';
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Also counted: a value parsed out of the field and refused when it comes back
  // null — `const delta = parseQty(amount.value)` then `if (delta === null)`.
  const parsedAs = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*parse\\w+\\(\\s*${escaped}\\.value`).exec(
    script,
  )?.[1];

  for (const guard of validationGuards(script)) {
    const mentionsField =
      new RegExp(`\\b${escaped}\\b`).test(guard.condition) ||
      (parsedAs !== undefined && new RegExp(`\\b${parsedAs}\\b`).test(guard.condition));
    if (!mentionsField) continue;
    // Another ref inside the same condition means the rule has a second half —
    // `noteRequired.value && note.value.trim() === ''`.
    const others = [...guard.condition.matchAll(/\b([A-Za-z_$][\w$]*)\.value\b/g)]
      .map((match) => match[1])
      .filter((name) => name !== ref);
    return others.length > 0 ? 'CONDITIONAL' : 'YES';
  }
  return 'NO';
}

/** The label a person reads, wherever this component chose to put it. */
function labelFor(template: string, tags: readonly Tag[], index: number, handle: string | null): {
  label: string;
  labelled: boolean;
} {
  const tag = tags[index];
  if (tag === undefined) return { label: '', labelled: false };

  // 1 — an explicit `<label for="…">` anywhere in the template.
  if (handle !== null) {
    for (const [at, candidate] of tags.entries()) {
      if (candidate.name !== 'label' || candidate.kind === 'CLOSE') continue;
      if (candidate.attrs.get('for') !== handle) continue;
      const text = labelText(textOf(template, tags, at));
      if (text !== '') return { label: text, labelled: true };
    }
  }

  // 2 — a `<label>` wrapped around the control.
  if (tag.ancestors.includes('label')) {
    for (let at = index - 1; at >= 0; at -= 1) {
      const candidate = tags[at];
      if (candidate?.name === 'label' && candidate.kind === 'OPEN') {
        const text = labelText(textOf(template, tags, at));
        if (text !== '') return { label: text.split(/\s{2,}/)[0] ?? text, labelled: true };
        break;
      }
    }
  }

  // 3 — a wrapper component that passes its own `label` prop down as the
  // accessible name. SearchField, AmountInput and ComboField all do this, and
  // reading only the DOM-level attributes would report the search box on every
  // list screen as having no name when it has one.
  const written = tag.attrs.get('label');
  if (written !== undefined && written !== '') {
    const text = expressionText(written);
    if (text !== '') return { label: text, labelled: true };
  }

  // 4 — an accessible name given directly.
  const aria = tag.attrs.get('aria-label');
  if (aria !== undefined && aria !== '') {
    const text = expressionText(aria);
    if (text !== '') return { label: text, labelled: true };
  }

  // 5 — nothing but a placeholder, which is not an accessible name.
  const placeholder = tag.attrs.get('placeholder');
  if (placeholder !== undefined && placeholder !== '' && !placeholder.includes('{')) {
    return { label: placeholder, labelled: false };
  }
  return { label: handle ?? '', labelled: false };
}

export function fields(template: string, script: string): readonly FieldItem[] {
  const tags = tokenize(template);
  const out: FieldItem[] = [];
  const seen = new Set<string>();

  for (const [index, tag] of tags.entries()) {
    if (tag.kind === 'CLOSE' || !CONTROL_TAGS.has(tag.name)) continue;
    if (tag.attrs.get('type') === 'hidden') continue;
    const handle = handleOf(tag);
    const { label, labelled } = labelFor(template, tags, index, handle);
    const id = handle ?? label;
    if (id === '' || seen.has(id)) continue;
    seen.add(id);

    const boundRef = tag.attrs.get('v-model') ?? null;
    out.push({
      id,
      label,
      labelled,
      kind: controlKind(tag, id, label),
      required: requiredness(script, tag, boundRef),
      inputMode: tag.attrs.get('inputmode') ?? null,
    });
  }
  return out;
}

/** Every dropdown, with the expression its options come from. */
export function dropdowns(
  template: string,
  script: string,
  all: readonly FieldItem[],
): readonly DropdownItem[] {
  const tags = tokenize(template);
  const out: DropdownItem[] = [];

  for (const field of all) {
    if (!['SELECT', 'SEARCHABLE_SELECT', 'MULTI_SELECT', 'RADIO'].includes(field.kind)) continue;
    const tag = tags.find((candidate) => candidate.kind !== 'CLOSE' && handleOf(candidate) === field.id);
    const options =
      tag?.attrs.get('options') ?? tag?.attrs.get('suggestions') ?? tag?.attrs.get('choices') ?? '';
    out.push({
      id: field.id,
      label: field.label,
      optionsExpression: options,
      searchable: field.kind === 'SEARCHABLE_SELECT',
      dependsOn: dependenciesOf(script, options, all),
    });
  }
  return out;
}

/**
 * What a dropdown's option list is filtered by.
 *
 * Read out of the `computed` behind the options and matched against the other
 * fields on the screen, which is the shape of every dependent dropdown the
 * owner named — an account list narrowed by payment method, a product list
 * narrowed by supplier. A dependency expressed some other way is not detected,
 * and the matrix says independent rather than guessing.
 */
function dependenciesOf(
  script: string,
  optionsExpression: string,
  all: readonly FieldItem[],
): readonly string[] {
  const name = optionsExpression.replace(/\.value$/, '').trim();
  if (name === '' || !/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const body = new RegExp(`const\\s+${name}\\s*=\\s*computed\\(([\\s\\S]{0,900}?)\\n\\);`).exec(script);
  if (body === null) return [];
  const source = body[1] ?? '';
  return all
    .filter((other) => other.id !== name && new RegExp(`\\b${refName(other.id)}\\.value\\b`).test(source))
    .map((other) => other.id);
}

/** `stock-reason` is bound to a ref called `reason`; ids are kebab, refs camel. */
function refName(id: string): string {
  const parts = id.split('-');
  return (parts.length === 1 ? id : parts[parts.length - 1] ?? id).replace(/[^\w$]/g, '');
}

const DESTRUCTIVE = /\b(?:delete|remove|void|deactivate|disable|revoke|reset business|discard)\b|cancel (?:the )?(?:day|document|sale|invoice|bill|purchase|claim|count|plan|order)/i;

/**
 * Every control a person can press, and how much it matters.
 *
 * A button inside a table row is a row action rather than a screen action, and
 * keeping them apart is the point of §5: `Save` happens once per screen and
 * `Delete` happens once per row, and they need different tests. Links styled as
 * buttons count — `Add product` on the Products screen is a `RouterLink` with
 * `class="btn btn-primary"`, and a matrix that missed it would be missing the
 * primary action of the busiest list in the product.
 */
export function actions(template: string): readonly ActionItem[] {
  const tags = tokenize(template);
  const out = new Map<string, ActionItem>();

  for (const [index, tag] of tags.entries()) {
    if (tag.kind === 'CLOSE') continue;
    const isButton = tag.name === 'button' || tag.name === 'Button';
    const isLinkButton =
      (tag.name === 'RouterLink' || tag.name === 'a') &&
      (tag.attrs.get('class') ?? '').split(/\s+/).includes('btn');
    if (!isButton && !isLinkButton) continue;

    const written = tag.attrs.get('label') ?? '';
    const label =
      (written === '' ? labelText(textOf(template, tags, index)) : expressionText(written)) ||
      expressionText(tag.attrs.get('aria-label') ?? '') ||
      expressionText(tag.attrs.get('title') ?? '');
    if (label === '' || label.length > 60) continue;

    const inRow = tag.ancestors.includes('td') || tag.ancestors.includes('Column');
    const classes = tag.attrs.get('class') ?? '';
    /*
     * Restoring something is never destructive, however it is styled. Several
     * screens draw `Reactivate` with the danger treatment because it sits in
     * the same confirmation dialog as `Delete`, and reading the colour rather
     * than the act put it on the destructive list — where it would have earned
     * a "did this ask first" test for an action that brings a record back.
     */
    const restoring = /\b(?:re-?activate|restore|undo|reopen)\b/i.test(label);
    const role: ActionItem['role'] = !restoring && (DESTRUCTIVE.test(label) || classes.includes('btn-danger'))
      ? 'DESTRUCTIVE'
      : inRow
        ? 'ROW'
        : classes.includes('btn-primary') || tag.attrs.get('type') === 'submit'
          ? 'PRIMARY'
          : 'SECONDARY';
    out.set(label, { label, role });
  }
  return [...out.values()];
}

/**
 * Every list on the screen.
 *
 * Both kinds count. PrimeVue's `DataTable` is used where a list needs its
 * features, and a plain `<table>` is used everywhere else — Products, the
 * busiest list in the product, is a plain one — so a scanner that only knew
 * `DataTable` would report the main screens as having no list at all.
 */
export function tables(template: string): readonly TableItem[] {
  const tags = tokenize(template);
  const out: TableItem[] = [];

  for (const [index, tag] of tags.entries()) {
    if (tag.kind === 'CLOSE' || (tag.name !== 'DataTable' && tag.name !== 'table')) continue;
    const block = textOf(template, tags, index);
    const inner = tokenize(block);
    const columns: string[] = [];

    for (const [at, cell] of inner.entries()) {
      if (cell.kind === 'CLOSE') continue;
      if (cell.name === 'Column') {
        const header = cell.attrs.get('header') ?? '';
        if (header !== '' && !header.includes('{')) columns.push(header);
      } else if (cell.name === 'SortableHeader') {
        // It renders the `<th>` itself (UI-14), so its `label` prop is the
        // column a person reads. Without this every sortable list reports one
        // or two columns instead of all of them.
        const header = cell.attrs.get('label') ?? '';
        if (header !== '' && !header.includes('{')) columns.push(header);
      } else if (cell.name === 'th') {
        const text = labelText(textOf(block, inner, at)) || cell.attrs.get('aria-label') || '';
        if (text !== '') columns.push(text);
      }
    }

    out.push({
      columns,
      sortable: /<SortableHeader|\bsortable\b/.test(block),
      // Keyset paging on this product is a "Show more" button rather than a
      // page-number strip (§2.7.I), so both forms count as paginated.
      paginated: /\bpaginator\b|nextCursor|Show more|Load more/.test(block + template),
      hasEmptyState: /<EmptyState|#empty/.test(block + template),
    });
  }
  return out;
}

/** Dialogs and drawers this screen can open — each one is a screen of its own. */
export function opensDialogs(template: string): readonly string[] {
  const names = new Set<string>();
  for (const tag of tokenize(template)) {
    if (tag.kind === 'CLOSE') continue;
    if (/^[A-Z]\w*(Dialog|Drawer|Sheet)$/.test(tag.name) && tag.name !== 'Dialog' && tag.name !== 'Drawer') {
      names.add(tag.name);
    }
  }
  return [...names];
}

/** Every message the screen refuses with, so a validation test can expect one. */
export function validationMessages(script: string): readonly string[] {
  const out = new Set<string>();
  for (const match of script.matchAll(/message:\s*'((?:[^'\\]|\\.)*)'/g)) {
    const text = match[1];
    if (text !== undefined && text.length > 3) out.add(text.replace(/\\'/g, "'"));
  }
  return [...out];
}

/** The API functions this screen calls, which is what a spec must see happen. */
export function apiCalls(script: string): readonly string[] {
  const out = new Set<string>();
  for (const match of script.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'[^']*\/api\/[^']*'/g)) {
    for (const name of (match[1] ?? '').split(',')) {
      const clean = name.replace(/^\s*type\s+/, '').trim();
      if (clean !== '' && /^[a-z]/.test(clean)) out.add(clean);
    }
  }
  return [...out];
}

/** Permission codes the screen draws itself from (UI-09). */
export function permissionsUsed(source: string): readonly string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(/\bcan\(\s*'([a-z0-9._]+)'\s*\)/g)) {
    const code = match[1];
    if (code !== undefined) out.add(code);
  }
  return [...out];
}

/** Whether the screen has tabs a person switches between. */
export function hasTabs(template: string): boolean {
  return /<Tabs\b|<TabView\b|<ModuleFeatureNav\b|role="tablist"/.test(template);
}
