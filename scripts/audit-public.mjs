import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const includeWorkingTree = process.argv.includes('--working-tree');

const sensitivePath = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*(?:private|secret|credential).*|id_rsa.*|.*\.(?:pem|p12|key))$/iu;
const sensitiveContent = [
  /-----BEGIN [^-\n]*PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]_|github_pat_|sk-or-v1-)[A-Za-z0-9_]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{24,}/iu,
  /\b(?:OPENAI|OPENROUTER|ANTHROPIC)_API_KEY\s*=\s*["']?(?!\$\{|<|your[_-]|test[_-]|change[_-]|replace[_-])[A-Za-z0-9_-]{16,}/iu,
  /(?:^|["'`\s])\/(?:Users|home)\/[^\s"'`/]+(?:\/|["'`\s]|$)/u,
  /\b[A-Z]:\\Users\\[^\\\s"'`]+/u,
];
const safePrivateKeyFixture = /-----BEGIN PRIVATE KEY-----(?:\s|\\n)*secret(?:\s|\\n)*-----END PRIVATE KEY-----/iu;

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function gitLines(args) {
  return git(args)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function gitNullLines(args) {
  return git(args)
    .split('\0')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function contentFinding(source, relativePath = '') {
  if (relativePath === 'scripts/audit-public.mjs') return false;
  if (isBinary(source)) return false;
  const text = source.toString('utf8').replace(safePrivateKeyFixture, '');
  return sensitiveContent.some((pattern) => pattern.test(text));
}

const files = includeWorkingTree
  ? gitNullLines(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  : gitNullLines(['ls-files', '-z']);
const findings = [];

for (const relativePath of files) {
  if (sensitivePath.test(relativePath)) findings.push(`path:${relativePath}`);
  try {
    if (contentFinding(readFileSync(resolve(root, relativePath)), relativePath)) {
      findings.push(`content:${relativePath}`);
    }
  } catch {
    findings.push(`unreadable:${relativePath}`);
  }
}

const commits = gitLines(['rev-list', '--all']);
for (const commit of commits) {
  for (const relativePath of gitNullLines(['ls-tree', '-r', '--name-only', '-z', commit])) {
    if (sensitivePath.test(relativePath)) findings.push(`history:${commit}:${relativePath}`);
    try {
      const source = execFileSync('git', ['show', `${commit}:${relativePath}`]);
      if (contentFinding(source, relativePath)) findings.push(`history:${commit}:${relativePath}`);
    } catch {
      findings.push(`history-unreadable:${commit}:${relativePath}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Public audit failed. Findings are reported as paths only:');
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public audit passed: ${files.length} candidate files and ${commits.length} commits checked.`);
}
