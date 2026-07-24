import "server-only"

import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"

/** Loads a version with its document, only if it belongs to the given user. */
export async function getOwnedVersion(userId: string, documentId: string, versionId: string) {
  const [row] = await db
    .select({
      versionId: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      filePath: documentVersions.filePath,
      pageCount: documentVersions.pageCount,
      documentId: documents.id,
      name: documents.name,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documentVersions.documentId, documents.id))
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(documentVersions.documentId, documentId),
        eq(documents.userId, userId)
      )
    )
  return row ?? null
}
