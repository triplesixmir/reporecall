export type SecretFindingKind = 'api-key' | 'bearer-token' | 'private-key' | 'credential-path';

export type SecretFinding = {
  kind: SecretFindingKind;
  start?: number;
  end?: number;
  message: string;
};

export type SecretScanOptions = {
  sourcePath?: string;
};

export type SecretScanResult = {
  findings: SecretFinding[];
  hasSecret: boolean;
};

export type RedactionResult = SecretScanResult & {
  redacted: string;
  blocked: boolean;
};

type TextMatch = SecretFinding & { start: number; end: number };

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const API_KEY_PATTERN = /\b(?:sk-(?:or-v1-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|gsk_[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})\b/g;
const ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)\s*[:=]\s*["']?([A-Za-z0-9_~+/=-]{12,}(?:\.[A-Za-z0-9_~+/=-]+)*)/gi;

function credentialPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  const normalized = path.replaceAll('\\', '/').toLocaleLowerCase();
  const basename = normalized.split('/').at(-1) ?? normalized;
  return basename === '.env' || basename.startsWith('.env.') || /(^|\/)(credentials?|secrets?|\.ssh)(\/|$)/u.test(normalized);
}

function pushMatches(
  findings: TextMatch[],
  input: string,
  pattern: RegExp,
  kind: SecretFindingKind,
  message: string,
  captureGroup = false,
): void {
  pattern.lastIndex = 0;
  for (const match of input.matchAll(pattern)) {
    const full = match[0];
    const capture = captureGroup ? match[1] : undefined;
    const start = (match.index ?? 0) + (capture === undefined ? 0 : full.indexOf(capture));
    const end = start + (capture ?? full).length;
    findings.push({ kind, start, end, message });
  }
}

function scanText(input: string): TextMatch[] {
  const findings: TextMatch[] = [];
  pushMatches(findings, input, PRIVATE_KEY_PATTERN, 'private-key', 'Private key material was detected.');
  pushMatches(findings, input, BEARER_PATTERN, 'bearer-token', 'Bearer token was detected.');
  pushMatches(findings, input, API_KEY_PATTERN, 'api-key', 'API credential was detected.');
  pushMatches(findings, input, ASSIGNMENT_PATTERN, 'api-key', 'Credential assignment was detected.', true);
  return findings.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function scanSecrets(input: string, options: SecretScanOptions = {}): SecretScanResult {
  const findings: SecretFinding[] = [...scanText(input)];
  if (credentialPath(options.sourcePath)) {
    findings.push({ kind: 'credential-path', message: `Credential-like path should not be imported: ${options.sourcePath ?? ''}` });
  }
  return { findings, hasSecret: findings.length > 0 };
}

function removeOverlappingMatches(matches: TextMatch[]): TextMatch[] {
  const accepted: TextMatch[] = [];
  for (const match of matches) {
    if (accepted.some((item) => match.start < item.end && item.start < match.end)) continue;
    accepted.push(match);
  }
  return accepted;
}

export function redactSecrets(input: string, options: SecretScanOptions = {}): RedactionResult {
  const scan = scanSecrets(input, options);
  const matches = removeOverlappingMatches(
    scan.findings.filter((finding): finding is TextMatch => finding.start !== undefined && finding.end !== undefined),
  );
  let redacted = input;
  for (const match of [...matches].reverse()) {
    redacted = `${redacted.slice(0, match.start)}[REDACTED ${match.kind}]${redacted.slice(match.end)}`;
  }
  const residual = redacted.replace(/\[REDACTED [^\]]+\]/gu, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const blocked = scan.hasSecret && residual.length === 0;
  return { ...scan, redacted: blocked ? '' : redacted, blocked };
}
