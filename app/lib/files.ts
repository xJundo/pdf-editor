import "server-only"

import { mkdir } from "node:fs/promises"
import path from "node:path"

// In Docker this is the shared volume mounted in both app and pdf-service.
// The pdf-service resolves the same relative paths against its own FILES_ROOT.
export const FILES_ROOT = path.resolve(
  process.env.FILES_ROOT ?? path.join(process.cwd(), ".data", "files")
)

export function versionRelativePath(userId: string, documentId: string, versionId: string) {
  return path.posix.join(userId, documentId, `${versionId}.pdf`)
}

/** Edit journal of a version, stored beside its PDF on the same volume. */
export function journalRelativePath(userId: string, documentId: string, versionId: string) {
  return path.posix.join(userId, documentId, `${versionId}.json`)
}

/** Absolute path for a stored file, guaranteed to stay inside FILES_ROOT. */
export function absoluteFilePath(relativePath: string) {
  const absolute = path.resolve(FILES_ROOT, relativePath)
  if (absolute !== FILES_ROOT && !absolute.startsWith(FILES_ROOT + path.sep)) {
    throw new Error(`path escapes FILES_ROOT: ${relativePath}`)
  }
  return absolute
}

export function documentDir(userId: string, documentId: string) {
  return absoluteFilePath(path.posix.join(userId, documentId))
}

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
}
