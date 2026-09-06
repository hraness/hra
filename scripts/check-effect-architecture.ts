/**
 * Effect architecture checks v1.2.1. Copy with its tests into the owning repository.
 * Build-time only: use that repository's TypeScript, no compiler patch/plugin.
 * This constrains reviewed modules; it is not a purity or security proof.
 */
import { resolve, relative } from "node:path";
import ts from "typescript";

export interface EffectArchitecturePolicy {
  readonly root: string;
  /** Every production file importing Effect must declare its role here. */
  readonly modules: readonly string[];
  readonly adapters: readonly string[];
  readonly runtimeRoots: readonly string[];
  /** Exact test/tool directories, never application-wide exclusions. */
  readonly ignoredDirectories?: readonly string[];
}

export interface ArchitectureFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const effectPath = /[/\\]effect[/\\](?:dist[/\\]dts|src)[/\\]/;
const effectModule = /^(?:effect(?:\/|$)|@effect\/)/;
const runtimeFunctions = /^(?:run(?:Sync|SyncExit|Promise|PromiseExit|Fork|Callback)(?:With)?|forkDaemon|unsafeMake)$/;
const erasedFailures = new Set(["orDie", "orDieWith", "ignore", "ignoreLogged"]);
const nativeModules = /^(?:node:|bun$|fs(?:\/|$)|child_process$|worker_threads$|http$|https$|net$|tls$|dgram$)/;
const ambientCalls = new Set(["fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"]);

/** Use the genuine Effect variance symbol, including aliases and unions. */
function effectVariants(type: ts.Type): readonly ts.Symbol[] {
  if (type.isUnionOrIntersection()) return type.types.flatMap(effectVariants);
  return type.getProperties().filter(symbol =>
    symbol.getName().startsWith("__@EffectTypeId@") &&
    symbol.declarations?.some(d => effectPath.test(d.getSourceFile().fileName)),
  );
}

export function inspectEffectArchitecture(
  program: ts.Program,
  policy: EffectArchitecturePolicy,
): readonly ArchitectureFinding[] {
  const checker = program.getTypeChecker();
  const root = resolve(policy.root);
  const modules = new Set(policy.modules.map(f => resolve(root, f)));
  const adapters = new Set(policy.adapters.map(f => resolve(root, f)));
  const runtimeRoots = new Set(policy.runtimeRoots.map(f => resolve(root, f)));
  const ignored = (policy.ignoredDirectories ?? []).map(f => resolve(root, f));
  const findings: ArchitectureFinding[] = [];
  const sourceByPath = new Map(program.getSourceFiles().map(s => [resolve(s.fileName), s]));
  for (const file of [...modules, ...adapters, ...runtimeRoots]) {
    if (!sourceByPath.has(file)) findings.push({ file: relative(root, file), line: 1,
      rule: "policy-source", message: "Declared architecture file is absent from this TypeScript program." });
  }
  for (const file of [...adapters, ...runtimeRoots]) {
    if (!modules.has(file)) findings.push({ file: relative(root, file), line: 1,
      rule: "policy-role", message: "An adapter/runtime root must also be a governed module." });
  }
  const report = (node: ts.Node, rule: string, message: string): void => {
    const source = node.getSourceFile();
    findings.push({ file: relative(root, source.fileName).replaceAll("\\", "/"),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      rule, message });
  };
  const actualSymbol = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  const externalEffectSymbol = (node: ts.Expression, seen = new Set<ts.Symbol>()): ts.Symbol | undefined => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    const symbol = ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      ? checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text)
      : actualSymbol(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    if (symbol.declarations?.some(d => effectPath.test(d.getSourceFile().fileName))) return symbol;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const result = externalEffectSymbol(declaration.initializer, seen);
        if (result) return result;
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const container = declaration.parent.parent;
        const property = declaration.propertyName ?? declaration.name;
        if (ts.isVariableDeclaration(container) && container.initializer &&
          (ts.isIdentifier(property) || ts.isStringLiteral(property))) {
          const member = checker.getTypeAtLocation(container.initializer).getProperty(property.text);
          if (member?.declarations?.some(d => effectPath.test(d.getSourceFile().fileName))) return member;
        }
      }
    }
    return undefined;
  };
  const isAmbient = (node: ts.Node): boolean => {
    const symbol = actualSymbol(node);
    return !!symbol?.declarations?.some(d => d.getSourceFile().isDeclarationFile);
  };
  const isEffect = (node: ts.Node): boolean => effectVariants(checker.getTypeAtLocation(node)).length > 0;
  const checkChannels = (node: ts.Node): void => {
    const type = checker.getTypeAtLocation(node);
    for (const variance of effectVariants(type)) {
      const fields = checker.getTypeOfSymbolAtLocation(variance, node);
      for (const channel of ["_E", "_R"]) {
        const field = fields.getProperty(channel);
        if (!field) continue;
        const signature = checker.getTypeOfSymbolAtLocation(field, node).getCallSignatures()[0];
        if (!signature) continue;
        const value = checker.getReturnTypeOfSignature(signature);
        if (value.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          report(node, "explicit-channel", `${channel === "_E" ? "Error" : "Requirement"} channel must not be any/unknown.`);
        }
      }
    }
  };
  for (const source of program.getSourceFiles()) {
    const file = resolve(source.fileName);
    if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) continue;
    const local = relative(root, file).replaceAll("\\", "/");
    if (local.startsWith("../") || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?tsx?$/.test(local)) continue;
    if (ignored.some(dir => file === dir || file.startsWith(dir + "/"))) continue;
    const findEffectImports = (node: ts.Node): boolean => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && effectModule.test(node.moduleSpecifier.text)) return true;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require" && isAmbient(node.expression)))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && effectModule.test(argument.text)) return true;
      }
      return ts.forEachChild(node, findEffectImports) ?? false;
    };
    const importsEffect = findEffectImports(source);
    if (!modules.has(file)) {
      if (importsEffect) report(source, "unclassified-module", "Production Effect import/export needs an explicit reviewed architecture role.");
      continue;
    }
    const adapter = adapters.has(file);
    const runtimeRoot = runtimeRoots.has(file);
    const references = new Map<ts.Symbol, number>();
    const countReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const declarationName = ts.isVariableDeclaration(parent) && parent.name === node;
        const assigned = ts.isBinaryExpression(parent) && parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (symbol && !declarationName && !assigned) references.set(symbol, (references.get(symbol) ?? 0) + 1);
      }
      ts.forEachChild(node, countReferences);
    };
    countReferences(source);
    // Source suppressions must not disable a policy inside application code.
    const suppression = /@ts-(?:ignore|nocheck|expect-error)|@effect-diagnostics[^\n]*(?:off|disable)/g;
    for (const match of source.text.matchAll(suppression)) {
      findings.push({ file: local, line: source.getLineAndCharacterOfPosition(match.index).line + 1,
        rule: "suppression", message: "Architecture/typing suppression requires removal or an explicit owner-reviewed policy change." });
    }
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        let expression = node.expression;
        while (ts.isParenthesizedExpression(expression) || ts.isVoidExpression(expression)) expression = expression.expression;
        const assignedSymbol = ts.isBinaryExpression(expression) && ts.isIdentifier(expression.left)
          ? checker.getSymbolAtLocation(expression.left) : undefined;
        const storesValue = ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (!ts.isIdentifier(expression.left) || (assignedSymbol !== undefined && (references.get(assignedSymbol) ?? 0) > 0));
        if (isEffect(expression) && !storesValue) report(expression, "floating-effect", "Effect work must be composed, returned or executed by its owner.");
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (isEffect(node) || isEffect(node.expression)) report(node, "effect-assertion", "Do not assert Effect success/error/requirement channels; provide and handle them.");
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isEffect(node.initializer)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const statement = node.parent.parent;
        const exported = ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported && symbol && (references.get(symbol) ?? 0) === 0) {
          report(node, "unused-effect", "An assigned Effect is never consumed or exported.");
        }
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "explicit-any", "Explicit any is not allowed in governed Effect modules.");
      if (ts.isTypeReferenceNode(node) || ts.isVariableDeclaration(node) || ts.isPropertySignature(node)) checkChannels(node);
      if (!adapter && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && nativeModules.test(node.moduleSpecifier.text)) {
        report(node, "native-import", "Native I/O imports belong in an adapter.");
      }
      if (ts.isCallExpression(node)) {
        if (!adapter && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require" && isAmbient(node.expression)))) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument) && nativeModules.test(argument.text)) {
            report(node, "native-import", "Native I/O imports belong in an adapter.");
          }
        }
        const symbol = externalEffectSymbol(node.expression);
        const constructsRuntime = symbol?.getName() === "make" && symbol.declarations?.some(d =>
          /[/\\](?:ManagedRuntime|Runtime)\.(?:d\.)?ts$/.test(d.getSourceFile().fileName));
        if (symbol && (runtimeFunctions.test(symbol.getName()) || constructsRuntime) && !runtimeRoot) {
          report(node, "runtime-owner", `${symbol.getName()} belongs in a declared runtime owner.`);
        }
        if (symbol && erasedFailures.has(symbol.getName())) {
          report(node, "erased-failure", "Handle expected failures explicitly; do not erase them or turn them into defects.");
        }
        if (!adapter) {
          const expression = node.expression;
          if (ts.isIdentifier(expression) && ambientCalls.has(expression.text) && isAmbient(expression)) {
            report(node, "ambient-io", "Use a declared service for ambient I/O and time.");
          }
          if (ts.isPropertyAccessExpression(expression)) {
            const owner = expression.expression;
            if (ts.isIdentifier(owner) && isAmbient(owner) &&
              ((owner.text === "Date" && expression.name.text === "now") ||
               (owner.text === "Math" && expression.name.text === "random") ||
               (["globalThis", "window"].includes(owner.text) && ambientCalls.has(expression.name.text)))) {
              report(node, "ambient-io", "Use a declared service for ambient I/O and time.");
            }
          }
        }
      }
      if (!adapter && ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        ["Promise", "Date", "Worker", "AbortController"].includes(node.expression.text) && isAmbient(node.expression)) {
        report(node, "native-constructor", "Foreign asynchronous resources belong in an adapter.");
      }
      if (!adapter && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "process" && node.name.text === "env" && isAmbient(node.expression)) {
        report(node, "ambient-config", "Configuration belongs in an injected service.");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const unique = new Map(findings.map(f => [`${f.file}:${f.line}:${f.rule}:${f.message}`, f]));
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Parse the real project config; callers separately retain ordinary tsc. */
export function createArchitectureProgram(configFile: string): ts.Program {
  const config = ts.readConfigFile(configFile, file => ts.sys.readFile(file));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configFile, ".."));
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}
