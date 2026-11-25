import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

const ROOT = process.cwd();

const PUBLIC_ROUTER_MOUNTS = new Set([
  '/health', // Health checks are intentionally available without authentication.
  '/api/auth', // Authentication endpoints must be reachable before a token exists.
  '/api/streams', // Stream routes apply their own API-key and scope authorization.
  '/metrics', // The metrics router enforces ADMIN_API_KEY authentication internally.
]);

const PUBLIC_ROOT_ROUTERS = new Set([
  'docsRouter', // The root-mounted docs router serves public documentation and schemas.
]);

const KNOWN_MIDDLEWARE = new Set([
  'csrfMiddleware',
  'requireJsonContentType',
  'requireJsonAccept',
]);

function isAppUse(node: ts.CallExpression): boolean {
  const expression = node.expression;
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'app' &&
    expression.name.text === 'use'
  );
}

function isProtectRouter(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'protectRouter'
  );
}

function isRouterHandler(node: ts.Expression): boolean {
  if (isProtectRouter(node)) return true;
  if (ts.isIdentifier(node)) return node.text.endsWith('Router');
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text.endsWith('Router')
  );
}

describe('structural auth registration', () => {
  it('requires protectRouter for every non-public router mount', () => {
    const appSrc = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');
    const sourceFile = ts.createSourceFile(
      'src/app.ts',
      appSrc,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const routerMounts: Array<{ path: string; handler: ts.Expression }> = [];

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && isAppUse(node)) {
        const [first, ...remaining] = node.arguments;
        const hasPath = first && ts.isStringLiteral(first);
        const path = hasPath ? first.text : '/';
        const handlers = hasPath ? remaining : node.arguments;

        for (const handler of handlers) {
          if (ts.isIdentifier(handler) && KNOWN_MIDDLEWARE.has(handler.text)) continue;
          if (!hasPath && !isRouterHandler(handler)) continue;
          routerMounts.push({ path, handler });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    expect(routerMounts.length).toBeGreaterThan(0);

    for (const { path, handler } of routerMounts) {
      if (PUBLIC_ROUTER_MOUNTS.has(path)) continue;
      if (ts.isIdentifier(handler) && PUBLIC_ROOT_ROUTERS.has(handler.text)) continue;

      expect(handler.getText(sourceFile)).toMatch(/^protectRouter\s*\(/);
    }
  });

  it('lists deliberate public routes', () => {
    const protect = readFileSync(join(ROOT, 'src', 'routes', 'protect.ts'), 'utf8');
    expect(protect).toMatch(/PUBLIC_ROUTE_PATHS/);
  });
});
