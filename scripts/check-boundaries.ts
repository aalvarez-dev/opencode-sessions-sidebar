import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const core = fileURLToPath(new URL("../src/core/", import.meta.url));
const violations: string[] = [];
let checked = 0;

function insideCore(path: string): boolean {
  const local = relative(core, path);
  return (
    local !== ".." && !local.startsWith("../") && !local.startsWith("..\\") && !isAbsolute(local)
  );
}

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
        !node.text.startsWith(".") ||
        !insideCore(resolve(dirname(path), node.text))
      ) {
        reject(node, "Core imports must be static relative paths within src/core.");
      }
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
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
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

await visitDirectory(core);
if (checked === 0) throw new Error("No core source files were checked.");
if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exitCode = 1;
} else {
  console.log(`Core dependency boundary checked (${checked} files).`);
}
