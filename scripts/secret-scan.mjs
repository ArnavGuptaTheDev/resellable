#!/usr/bin/env node
// Pre-commit secret scan. Scans every file git would commit (tracked + untracked,
// minus .gitignore'd) for likely credentials and real email addresses.
// Uses gitleaks instead if it is installed. Exit code 1 on any finding.
//
//   npm run scan:secrets

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
if (gitleaks.status === 0) {
  console.log(`gitleaks ${gitleaks.stdout.trim()} found, using it.`);
  const r = spawnSync('gitleaks', ['dir', '.', '--redact', '-v'], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/^(package-lock\.json|worker-configuration\.d\.ts)$/.test(f))
  .filter((f) => !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf)$/i.test(f));

const rules = [
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  // The client id is public by design and belongs in wrangler.jsonc vars; flag it anywhere else.
  ['Google OAuth client id', /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/, ['wrangler.jsonc']],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['OpenAI/Anthropic-style key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Cloudflare account/zone id', /\b(account_id|zone_id)\b\s*[:=]\s*["']?[0-9a-f]{32}/i],
  ['Assigned secret value', /\b(SECRET|TOKEN|PASSWORD|API_KEY|CLIENT_SECRET|SESSION_SECRET)\b["']?\s*[:=]\s*["']?(?![<{$]|your|example|change|placeholder)[A-Za-z0-9_\/+=-]{16,}/i],
  ['Email (non-example domain)', /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!noreply\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i],
  ['Local user path', /[A-Z]:\\Users\\[^\\\s]+|\/Users\/[a-z][^/\s]+\/|\/home\/[a-z][^/\s]+\//],
];

// Known-safe matches: package metadata, docs URLs, etc.
const allow = [/@astrojs\//, /@fontsource\//, /@cloudflare\//, /@preact\//, /@types\//, /@vitest\//];

let findings = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re, allowedFiles = []] of rules) {
      if (allowedFiles.includes(file)) continue;
      const m = line.match(re);
      if (!m || allow.some((a) => a.test(m[0]))) continue;
      findings++;
      const shown = m[0].length > 12 ? `${m[0].slice(0, 6)}…${m[0].slice(-3)}` : m[0];
      console.log(`${file}:${i + 1}  ${name}  [${shown}]`);
    }
  });
}

console.log(`\nScanned ${files.length} files. ${findings ? `${findings} finding(s).` : 'No findings.'}`);
process.exit(findings ? 1 : 0);
