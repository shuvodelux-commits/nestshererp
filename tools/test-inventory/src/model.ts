/**
 * What the test inventory knows about SherERP, and nothing about how it is
 * tested (owner request 2026-09-03).
 *
 * The shapes here are deliberately dumb records rather than classes: they are
 * written to `docs/testing/inventory.json`, read back by the coverage report,
 * and diffed in review. A reviewer comparing two runs should be able to read
 * the diff, which rules out anything with behaviour attached to it.
 */

/** How a control behaves, which is what decides the cases worth writing. */
export type ControlKind =
  | 'TEXT'
  | 'TEXTAREA'
  | 'MONEY'
  | 'QUANTITY'
  | 'NUMBER'
  | 'DATE'
  | 'SELECT'
  | 'SEARCHABLE_SELECT'
  | 'MULTI_SELECT'
  | 'CHECKBOX'
  | 'TOGGLE'
  | 'RADIO'
  | 'OTP'
  | 'FILE'
  | 'UNKNOWN';

/**
 * `CONDITIONAL` is a real answer rather than a hedge: a note required only
 * when the reason is "Other" is a rule the product genuinely has, and a
 * required-field test that ignores the condition tests a rule it does not.
 */
export type Requiredness = 'YES' | 'CONDITIONAL' | 'NO';

export interface FieldItem {
  /** The `id`/`input-id` the label points at, or the ref it is bound to. */
  readonly id: string;
  /** The visible English label, which is what a semantic selector matches. */
  readonly label: string;
  /**
   * False when the control has no accessible name — named only by a
   * placeholder, or by nothing at all. Both an accessibility defect (§13) and a
   * control no semantic selector can reach, so it is surfaced rather than
   * quietly dropped.
   */
  readonly labelled: boolean;
  readonly kind: ControlKind;
  readonly required: Requiredness;
  readonly inputMode: string | null;
}

export interface DropdownItem {
  readonly id: string;
  readonly label: string;
  /** The `:options` expression, so the option source can be traced by hand. */
  readonly optionsExpression: string;
  readonly searchable: boolean;
  /** A dependent dropdown names what it is filtered by. */
  readonly dependsOn: readonly string[];
}

export interface ActionItem {
  readonly label: string;
  /** `PRIMARY` is the one action the screen exists to perform. */
  readonly role: 'PRIMARY' | 'SECONDARY' | 'ROW' | 'DESTRUCTIVE';
}

export interface TableItem {
  readonly columns: readonly string[];
  readonly sortable: boolean;
  readonly paginated: boolean;
  readonly hasEmptyState: boolean;
}

export interface ScreenItem {
  /** Stable id used to link a test to this screen: `screen:products`. */
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind: 'PAGE' | 'DIALOG' | 'DRAWER' | 'COMPONENT';
  readonly route: string | null;
  readonly routeName: string | null;
  readonly navPermissions: readonly string[];
  readonly permissionsUsed: readonly string[];
  readonly fields: readonly FieldItem[];
  readonly dropdowns: readonly DropdownItem[];
  readonly actions: readonly ActionItem[];
  readonly dialogs: readonly string[];
  readonly tables: readonly TableItem[];
  readonly hasSearch: boolean;
  readonly hasFilters: boolean;
  readonly hasTabs: boolean;
  readonly validationMessages: readonly string[];
  readonly apiCalls: readonly string[];
  /** A screen a shopkeeper uses on the floor is a mobile-layout obligation. */
  readonly mobileRelevant: boolean;
}

export interface EndpointItem {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly file: string;
  readonly permissions: readonly string[];
}

export interface PermissionItem {
  readonly code: string;
  readonly constant: string;
  readonly module: string;
}

export interface WorkflowItem {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly string[];
}

export interface Inventory {
  readonly generatedFrom: string;
  readonly screens: readonly ScreenItem[];
  readonly endpoints: readonly EndpointItem[];
  readonly permissions: readonly PermissionItem[];
  readonly workflows: readonly WorkflowItem[];
}
