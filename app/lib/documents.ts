import "server-only"

import { and, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"

/** Loads a version with its document, only if it belongs to the given user. */
export async function getOwnedVersion(userId: string, documentId: string, versionId: string) {
  const [row] = await db
    .select({
      versionId: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      versionName: documentVersions.name,
      sourceVersionId: documentVersions.sourceVersionId,
      filePath: documentVersions.filePath,
      journalPath: documentVersions.journalPath,
      editCount: documentVersions.editCount,
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

/** Lists every version of an owned document, newest first. */
export async function getDocumentVersions(userId: string, documentId: string) {
  return db
    .select({
      id: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      name: documentVersions.name,
      fileSize: documentVersions.fileSize,
      pageCount: documentVersions.pageCount,
      sourceVersionId: documentVersions.sourceVersionId,
      editCount: documentVersions.editCount,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documentVersions.documentId, documents.id))
    .where(and(eq(documentVersions.documentId, documentId), eq(documents.userId, userId)))
    .orderBy(desc(documentVersions.versionNumber))
}
