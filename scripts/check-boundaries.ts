import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultCore = fileURLToPath(new URL("../src/core/", import.meta.url));

function insideCore(core: string, path: string): boolean {
  const local = relative(core, path);
  return (
    local !== ".." && !local.startsWith("../") && !local.startsWith("..\\") && !isAbsolute(local)
  );
}

/** Syntax-level guardrails, not a sandbox or complete data-flow analysis. */
export async function checkCoreBoundaries(core: string) {
  const violations: string[] = [];
  let checked = 0;

  async function visitDirectory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      checked++;
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function reject(node: ts.Node, message: string): void {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push(`${relative(core, path)}:${line}: ${message}`);
      }
      function checkSpecifier(node: ts.Node): void {
        if (
          !ts.isStringLiteralLike(node) ||
          !(node.text.startsWith("./") || node.text.startsWith("../")) ||
          !insideCore(core, resolve(dirname(path), node.text))
        ) {
          reject(node, "Core imports must be static relative paths within src/core.");
        }
      }
      function visit(node: ts.Node): void {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          checkSpecifier(node.moduleSpecifier);
        }
        if (ts.isImportEqualsDeclaration(node))
          reject(node, "Import assignments are not allowed in core.");
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          checkSpecifier(node.argument.literal);
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          reject(node, "Dynamic module loading is not allowed in core.");
        }
        const access = accessPath(node);
        if (access === "Date.now" || access === "Math.random") {
          reject(node, "Wall-clock time and randomness must be supplied as explicit inputs.");
        }
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          accessPath(node.expression) === "Date" &&
          (ts.isCallExpression(node) ||
            !node.arguments?.length ||
            node.arguments.some(ts.isSpreadElement))
        ) {
          reject(node, "Reading the current date is not allowed in core.");
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }

  await visitDirectory(core);
  if (checked === 0) throw new Error("No core source files were checked.");
  return { checked, violations };
}

/** Also recognizes direct globalThis and string-literal bracket access. */
function accessPath(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text === "globalThis" ? "" : node.text;
  if (ts.isParenthesizedExpression(node)) return accessPath(node.expression);
  let property: string | undefined;
  if (ts.isPropertyAccessExpression(node)) property = node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    property = node.argumentExpression.text;
  }
  if (
    property === undefined ||
    !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  )
    return undefined;
  const parent = accessPath(node.expression);
  return parent === undefined ? undefined : parent ? `${parent}.${property}` : property;
}

if (import.meta.main) {
  const { checked, violations } = await checkCoreBoundaries(
    resolve(process.argv[2] ?? defaultCore),
  );
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
  } else {
    console.log(`Core dependency boundary checked (${checked} files).`);
  }
}
