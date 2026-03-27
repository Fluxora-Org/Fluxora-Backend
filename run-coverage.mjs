import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

let output = '';
let exitCode = 0;
try {
  output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.js --coverage --forceExit',
    { encoding: 'utf8', stdio: 'pipe' }
  );
} catch (e) {
  output = String(e.stdout || '') + String(e.stderr || '');
  exitCode = 1;
}

writeFileSync('coverage-output.txt', output);
const lines = output.split('\n');
const start = lines.findIndex(l => l.includes('% Stmts'));
const end = lines.findIndex((l, i) => i > start && l.trim() === '');
const table = start >= 0 ? lines.slice(start, end > start ? end : start + 50) : lines.slice(-40);
writeFileSync('coverage-table.txt', table.join('\n'));
process.exit(exitCode);
