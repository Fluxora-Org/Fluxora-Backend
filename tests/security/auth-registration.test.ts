import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (full.includes('node_modules')) return [];
    try {
      const stat = require('fs').statSync(full);
      if (stat.isDirectory()) return listTs(full);
    } catch {}
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const ROUTE_FILES = [...listTs(join(ROOT, 'src', 'routes'))].map((file) => ({ file: relative(ROOT, file).replace(/\\/g, '/'), src: readFileSync(file, 'utf8') }));

describe('structural auth registration', () => {
  it('ensures protected routers are wrapped with protectRouter', () => {
    const appSrc = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');

    // Extract every app.use mount path and the RHS source text around it.
    const mounts = Array.from(appSrc.matchAll(/app\.use\(([^,]+),?\s*([^;\)]+)\)?/g)).map((m) => ({ raw: m[0], path: m[1].trim(), handler: m[2]?.trim() }));

    // Load declared public paths to allow exceptions.
    const protectSrc = readFileSync(join(ROOT, 'src', 'routes', 'protect.ts'), 'utf8');
    const publicPathsMatch = protectSrc.match(/new Set<string>\(\[([\s\S]*?)\]\)/);
    const publicPaths: string[] = publicPathsMatch ? Array.from(publicPathsMatch[1].matchAll(/'([^']+)'/g)).map((x) => x[1]) : [];

    for (const m of mounts) {
      const p = m.path.replace(/^['"`]|['"`]$/g, '');
      if (!p.startsWith('/')) continue; // skip middleware mounts like app.use(rateLimiter)
      if (publicPaths.includes(p)) continue;

      // Handler should be a protectRouter(...) expression for protected mounts
      expect(m.raw).toMatch(/protectRouter\(/);
    }
  });

  it('lists deliberate public routes', () => {
    const protect = readFileSync(join(ROOT, 'src', 'routes', 'protect.ts'), 'utf8');
    expect(protect).toMatch(/PUBLIC_ROUTE_PATHS/);
  });
});
