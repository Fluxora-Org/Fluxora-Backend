const fs = require('fs');
const { execSync } = require('child_process');

function main() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync('audit.json', 'utf8'));
  } catch (err) {
    console.log('No audit.json found or invalid JSON — skipping.');
    process.exit(0);
  }

  const vulnerabilities = data.vulnerabilities || data.advisories || {};
  const entries = Object.values(vulnerabilities || {});
  if (!entries || entries.length === 0) {
    console.log('No high/critical vulnerabilities found.');
    process.exit(0);
  }

  const lines = [];
  lines.push('PNPM AUDIT: High/Critical vulnerabilities detected');
  lines.push('');
  for (const v of entries) {
    const title = v.title || v.name || v.module_name || 'unknown';
    const severity = v.severity || v.level || 'unknown';
    const cves = (v.cves && v.cves.length) ? v.cves.join(', ') : (v.cve || 'N/A');
    const via = v.via ? JSON.stringify(v.via) : '';
    lines.push(`- ${title} — severity: ${severity} — CVEs: ${cves}`);
    if (via) lines.push(`  details: ${via}`);
  }

  const body = lines.join('\n');

  const prNumber = process.env.PR_NUMBER;
  if (prNumber) {
    try {
      console.log(`Commenting on PR #${prNumber}`);
      execSync(`gh pr comment ${prNumber} --body "${body.replace(/"/g, '\\"')}"` , { stdio: 'inherit' });
    } catch (err) {
      console.error('Failed to post PR comment via gh CLI.');
    }
  }

  console.log(body);
  // Fail the job to block merge
  process.exit(1);
}

main();
