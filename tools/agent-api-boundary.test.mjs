import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function visit(node, action) {
  action(node);
  ts.forEachChild(node, child => visit(child, action));
}

const files = sourceFiles(sourceRoot);

test('Control Plane runtime has no local process or shell launcher', () => {
  const forbidden = new Set(['child_process', 'node:child_process', 'execa', 'zx', 'shelljs', 'cross-spawn',
    'worker_threads', 'node:worker_threads', '@opencode-ai/sdk', 'openai', '@anthropic-ai/sdk', '@google/generative-ai']);
  const imports = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    visit(source, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && forbidden.has(node.moduleSpecifier.text)) imports.push(`${relative(sourceRoot, file)}:${node.moduleSpecifier.text}`);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && forbidden.has(node.arguments[0].text)) {
        imports.push(`${relative(sourceRoot, file)}:${node.arguments[0].text}`);
      }
    });
  }
  assert.deepEqual(imports, []);
});

test('Runner run endpoints are owned by the Runner API adapter', () => {
  const endpointOwners = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    visit(source, node => {
      const value = ts.isStringLiteralLike(node) ? node.text : null;
      if (value && /\/v1\/runs(?:\/|$)/.test(value)) endpointOwners.push(relative(sourceRoot, file));
    });
  }
  assert.ok(endpointOwners.length > 0);
  assert.deepEqual([...new Set(endpointOwners)], ['runner-adapter/runner-api-adapter.ts']);
});
