import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config.js';

const repoRoot = path.resolve(__dirname, '../..');

function collectTestFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(path.relative(repoRoot, fullPath).replace(/\\/g, '/'));
    }
  }

  return files;
}

function matchesVitestInclude(filePath: string, include: string[]): boolean {
  return include.some((pattern) => {
    if (pattern === 'tests/**/*.test.ts') {
      return filePath.startsWith('tests/') && filePath.endsWith('.test.ts');
    }

    if (pattern === 'src/**/*.test.ts') {
      return filePath.startsWith('src/') && filePath.endsWith('.test.ts');
    }

    return false;
  });
}

describe('Vitest runner coverage', () => {
  it('includes every repository test file under tests/ and src/', () => {
    const include = vitestConfig.test?.include ?? [];
    const diskTests = [
      ...collectTestFiles(path.join(repoRoot, 'tests')),
      ...collectTestFiles(path.join(repoRoot, 'src')),
    ].sort();
    const missedTests = diskTests.filter((file) => !matchesVitestInclude(file, include));

    expect(diskTests.length).toBeGreaterThan(0);
    expect(missedTests).toEqual([]);
  });

  it('does not keep Jest runner configuration or package dependencies', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(existsSync(path.join(repoRoot, 'jest.config.cjs'))).toBe(false);
    expect(existsSync(path.join(repoRoot, 'jest.config.js'))).toBe(false);
    expect(packageJson.devDependencies).not.toHaveProperty('jest');
    expect(packageJson.devDependencies).not.toHaveProperty('ts-jest');
    expect(packageJson.devDependencies).not.toHaveProperty('@types/jest');
    expect(packageJson.scripts?.test).toBe('vitest run');
    expect(packageJson.scripts?.['test:coverage']).toBe('vitest run --coverage');
  });
});
