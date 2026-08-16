import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { pinnedCodexRequests } from "../src/codex";

const runtimeSource = fileURLToPath(new URL("../src", import.meta.url));
const codexSource = resolve(runtimeSource, "codex");
const codexIndex = resolve(codexSource, "index.ts");
const pinnedRegistry = resolve(codexSource, "pinned-codecs.ts");
const legacyClient = resolve(runtimeSource, "app-server.ts");
const legacyProjectionAdapter = resolve(runtimeSource, "codex-projection-adapter.ts");
const runtimeRouter = resolve(runtimeSource, "accounts", "runtime-router.ts");
const codexPersistentActorProvider = resolve(
  runtimeSource,
  "harness",
  "codex-persistent-actor-provider.ts",
);
const persistentActors = resolve(runtimeSource, "harness", "persistent-actors.ts");

const allowedPrivateCodexImports = new Map<string, ReadonlySet<string>>([
  [
    codexPersistentActorProvider,
    new Set(["classifyHraRlmDynamicToolSpecDigest"]),
  ],
  [
    persistentActors,
    new Set(["HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256"]),
  ],
]);

const prohibitedOutsideCodexSymbols = new Set([
  "CodexNotification",
  "CodexProjectionAdapter",
  "CodexRawMethodPolicy",
  "CodexRequestIntent",
  "CodexRequestOptions",
  "CodexRpcCore",
  "ParsedCodexNotification",
  "parseCodexNotification",
  "projectCodexNotificationFacts",
]);

const prohibitedPublicSymbols = new Set([
  "CodexProjectionAdapter",
  "CodexRawMethodPolicy",
  "CodexRequestIntent",
  "CodexRequestOptions",
  "CodexRpcCore",
  "ParsedCodexNotification",
  "parseCodexNotification",
  "projectCodexNotificationFacts",
]);

function sourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function location(file: ts.SourceFile, node: ts.Node): string {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${file.fileName}:${String(line + 1)}:${String(character + 1)}`;
}

function constantString(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = constantString(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function moduleSpecifier(node: ts.Node): ts.Expression | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier ?? null;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0] ?? null;
  }
  return null;
}

function resolvesInsidePrivateCodexModule(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(from), specifier).replace(/\.(?:js|ts)$/u, "");
  const root = codexSource.replace(/\.(?:js|ts)$/u, "");
  if (target === root || target === `${root}${sep}index`) return false;
  return target.startsWith(`${root}${sep}`);
}

function isAllowedPrivateCodexImport(
  path: string,
  node: ts.Node,
  specifier: string,
): boolean {
  const allowedNames = allowedPrivateCodexImports.get(path);
  if (
    allowedNames === undefined ||
    specifier !== "../codex/dynamic-tool" ||
    !ts.isImportDeclaration(node)
  ) {
    return false;
  }
  const clause = node.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return false;
  }
  const importedNames = clause.namedBindings.elements.map((element) => {
    if (element.isTypeOnly || element.propertyName !== undefined) return null;
    return element.name.text;
  });
  return importedNames.every((name): name is string => name !== null) &&
    importedNames.length === allowedNames.size &&
    importedNames.every((name) => allowedNames.has(name));
}

function exportedNames(file: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.exportClause === undefined) {
      const specifier = statement.moduleSpecifier === undefined
        ? null
        : constantString(statement.moduleSpecifier);
      if (specifier?.endsWith("/rpc-core") === true || specifier === "./rpc-core") {
        names.add("*");
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

test("production code has one structural pinned Codex boundary", async () => {
  const operationMethods: ReadonlySet<string> = new Set(
    Object.values(pinnedCodexRequests).map(({ method }) => method),
  );
  const violations: string[] = [];
  const observedAllowedPrivateImports = new Set<string>();
  const glob = new Bun.Glob("**/*.ts");

  for await (const path of glob.scan({ cwd: runtimeSource, absolute: true })) {
    const source = await readFile(path, "utf8");
    const file = sourceFile(path, source);
    const outsideCodex = !path.startsWith(`${codexSource}${sep}`);

    const visit = (node: ts.Node): void => {
      const specifierNode = moduleSpecifier(node);
      if (outsideCodex && specifierNode !== null) {
        const specifier = constantString(specifierNode);
        if (specifier !== null && resolvesInsidePrivateCodexModule(path, specifier)) {
          if (isAllowedPrivateCodexImport(path, node, specifier)) {
            observedAllowedPrivateImports.add(path);
          } else {
            violations.push(`${location(file, specifierNode)} imports private Codex module ${specifier}`);
          }
        }
      }

      if (
        outsideCodex &&
        ts.isIdentifier(node) &&
        prohibitedOutsideCodexSymbols.has(node.text) &&
        !(path === runtimeRouter && node.text === "CodexNotification")
      ) {
        violations.push(`${location(file, node)} references raw Codex symbol ${node.text}`);
      }

      if (ts.isExpression(node)) {
        const value = constantString(node);
        if (
          value !== null &&
          operationMethods.has(value) &&
          path !== pinnedRegistry
        ) {
          violations.push(`${location(file, node)} contains raw Codex operation ${value}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  expect(violations).toEqual([]);
  expect([...observedAllowedPrivateImports].sort()).toEqual(
    [...allowedPrivateCodexImports.keys()].sort(),
  );

  const publicIndex = sourceFile(codexIndex, await readFile(codexIndex, "utf8"));
  const publicExports = exportedNames(publicIndex);
  expect(publicExports.has("*")).toBeFalse();
  for (const name of prohibitedPublicSymbols) expect(publicExports.has(name)).toBeFalse();
  expect(await Bun.file(legacyClient).exists()).toBeFalse();
  expect(await Bun.file(legacyProjectionAdapter).exists()).toBeFalse();
});
