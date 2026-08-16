import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

import {
  CLOCK_FILE,
  CLOCK_RULE,
  DOM_GLOBALS,
  DOM_RULE,
  IMPORT_RULES,
} from './rules';

export interface Violation {
  /** Rule id from rules.ts. */
  readonly rule: string;
  /** Path relative to the scanned root, always with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '__fixtures__']);

/** Collects every .ts file under `root`, ignoring build output and fixtures. */
function collectSourceFiles(root: string, dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) collectSourceFiles(root, full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(toPosix(relative(root, full)));
    }
  }
  return found;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function inScope(file: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => file.startsWith(`${scope}/`));
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Module specifier of an import/export/require/dynamic-import, or undefined. */
function moduleSpecifierOf(node: ts.Node): ts.StringLiteralLike | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node)) {
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const [first] = node.arguments;
    if ((isRequire || isDynamicImport) && first !== undefined && ts.isStringLiteralLike(first)) {
      return first;
    }
  }
  return undefined;
}

function usesAmbientClock(node: ts.Node): string | undefined {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
    return 'new Date()';
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Date' &&
    node.expression.name.text === 'now'
  ) {
    return 'Date.now()';
  }
  return undefined;
}

function usesDomGlobal(node: ts.Node): string | undefined {
  if (!ts.isIdentifier(node) || !DOM_GLOBALS.includes(node.text)) return undefined;
  const parent = node.parent as ts.Node | undefined;
  // `foo.document` and `{ document: x }` are not the global.
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return undefined;
  }
  if (parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node) {
    return undefined;
  }
  return node.text;
}

function checkFile(root: string, file: string): Violation[] {
  const text = readFileSync(join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined) {
      for (const rule of IMPORT_RULES) {
        if (inScope(file, rule.scopes) && rule.isBanned(specifier.text)) {
          violations.push({
            rule: rule.id,
            file,
            line: lineOf(source, specifier),
            detail: `imports "${specifier.text}" — ${rule.message}`,
          });
        }
      }
    }

    if (inScope(file, DOM_RULE.scopes)) {
      const domGlobal = usesDomGlobal(node);
      if (domGlobal !== undefined) {
        violations.push({
          rule: DOM_RULE.id,
          file,
          line: lineOf(source, node),
          detail: `uses "${domGlobal}" — ${DOM_RULE.message}`,
        });
      }
    }

    if (file !== CLOCK_FILE) {
      const clockUse = usesAmbientClock(node);
      if (clockUse !== undefined) {
        violations.push({
          rule: CLOCK_RULE.id,
          file,
          line: lineOf(source, node),
          detail: `uses ${clockUse} — ${CLOCK_RULE.message}`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

/** Scans every .ts file under `root` and returns all layering violations. */
export function checkBoundaries(root: string): Violation[] {
  const files = collectSourceFiles(root, root, []).sort();
  return files.flatMap((file) => checkFile(root, file));
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  [${v.rule}] ${v.file}:${v.line} ${v.detail}`).join('\n');
}
