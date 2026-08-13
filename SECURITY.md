# Security Policy

Please do not disclose sensitive vulnerabilities in a public issue. After the repository is published, use its configured private security channel. Until then, contact the maintainers privately through the channel provided with the release.

When reporting a vulnerability, include the affected version or commit, a minimal reproduction, impact, and a suggested mitigation when known. Redact credentials, private memories, tokens, and user-specific paths from the report. Do not attach a real brain or a real `CODEX_HOME`.

RepoRecall handles potentially sensitive memory. It does not guarantee that every secret can be detected. Review generated memories before committing them, use private Git remotes for private memory, and never store credentials intentionally.

The project currently has no guaranteed response-time or bounty program. Maintainers will acknowledge reports when practical and coordinate disclosure after a fix or mitigation is available.
