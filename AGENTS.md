<!-- BEGIN REPORECALL MANAGED BLOCK -->
## RepoRecall memory

Canonical memory files are Markdown with YAML frontmatter and are the durable source of truth. SQLite is only a rebuildable local index. Do not store secrets, credentials, private keys, or raw transcripts in memory files.

Use RepoRecall MCP tools or the local CLI for memory operations. Durable session summaries are created only after an explicit checkpoint.
<!-- END REPORECALL MANAGED BLOCK -->
