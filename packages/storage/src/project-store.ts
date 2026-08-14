import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  parseProjectFile,
  serializeProjectRecord,
  type ProjectRecord,
} from '@reporecall/core';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readProjectManifest(path: string): Promise<ProjectRecord | null> {
  try {
    const source = await readFile(path, 'utf8');
    return parseProjectFile(source, path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function createProjectManifest(
  path: string,
  candidate: ProjectRecord,
): Promise<{ record: ProjectRecord; created: boolean }> {
  await mkdir(dirname(path), { recursive: true });
  const source = serializeProjectRecord(candidate);
  try {
    await writeFile(path, source, { encoding: 'utf8', flag: 'wx' });
    return { record: candidate, created: true };
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const record = await readProjectManifest(path);
    if (record === null) {
      throw new Error(`Project manifest disappeared while creating "${path}"`);
    }
    return { record, created: false };
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
