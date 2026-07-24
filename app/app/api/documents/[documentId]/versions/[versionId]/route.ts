import { rm } from "node:fs/promises"

import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"
import { absoluteFilePath } from "@/lib/files"
import { getSession } from "@/lib/session"

/** Deletes a single version. A document must always keep at least one. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId, versionId } = await params

  const owned = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, session.user.id)))
  if (owned.length === 0) {
    return Response.json({ error: "Document introuvable." }, { status: 404 })
  }

  const remaining = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
  if (remaining.length <= 1) {
    return Response.json(
      { error: "Impossible de supprimer la dernière version du document." },
      { status: 409 }
    )
  }

  const [deleted] = await db
    .delete(documentVersions)
    .where(
      and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId))
    )
    .returning({ filePath: documentVersions.filePath })

  if (!deleted) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  await rm(absoluteFilePath(deleted.filePath), { force: true })
  return Response.json({ ok: true })
}
