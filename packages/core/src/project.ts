import { parse, stringify } from 'yaml';
import { z } from 'zod';

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROJECT_IDENTITIES = ['git-remote', 'local'] as const;
export type ProjectIdentity = (typeof PROJECT_IDENTITIES)[number];

export type ProjectRecord = {
  schema: typeof PROJECT_SCHEMA_VERSION;
  kind: 'project';
  id: string;
  name: string;
  identity: ProjectIdentity;
  remoteFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

const projectRecordShape = {
  schema: z.literal(PROJECT_SCHEMA_VERSION),
  kind: z.literal('project'),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  identity: z.enum(PROJECT_IDENTITIES),
  remoteFingerprint: z.string().trim().min(1).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
};

export const projectRecordSchema = z
  .object(projectRecordShape)
  .strict()
  .superRefine((project, context) => {
    if (project.identity === 'git-remote' && project.remoteFingerprint === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['remoteFingerprint'],
        message: 'Git projects require a remote fingerprint',
      });
    }
    if (project.identity === 'local' && project.remoteFingerprint !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['remoteFingerprint'],
        message: 'Local projects must not carry a remote fingerprint',
      });
    }
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeProjectRecord(record: ProjectRecord): string {
  const validated = projectRecordSchema.parse(record) as ProjectRecord;
  const frontmatter = stringify(validated).trimEnd();
  return `---\n${frontmatter}\n---\n\n# ${validated.name}\n\nProject metadata for this repository.\n`;
}

export function parseProjectFile(source: string, filePath = '<project>'): ProjectRecord {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`Invalid project manifest "${filePath}": missing YAML frontmatter`);
  }

  try {
    const yamlSource = match[1];
    if (yamlSource === undefined) throw new Error('frontmatter delimiters are incomplete');
    const raw: unknown = parse(yamlSource) as unknown;
    if (!isRecord(raw)) throw new Error('YAML frontmatter must be an object');
    return projectRecordSchema.parse(raw) as ProjectRecord;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown validation error';
    throw new Error(`Invalid project manifest "${filePath}": ${detail}`, { cause: error });
  }
}
