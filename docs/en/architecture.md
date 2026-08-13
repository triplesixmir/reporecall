# Architecture

RepoRecall stores durable memory in small Markdown files with versioned YAML frontmatter. A local SQLite database indexes those files for full-text search and filtering, but it is always safe to delete and rebuild.

The core is intentionally independent from any model vendor. MCP, Codex, and future agent adapters consume the same store and context builder.
