import { rm } from "node:fs/promises"

import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"
import { absoluteFilePath } from "@/lib/files"
import { getSession } from "@/lib/session"

/** Renames a single version. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId, versionId } = await params
  let body: { name?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Corps de requête invalide." }, { status: 400 })
  }

  if (body.name !== null && typeof body.name !== "string") {
    return Response.json({ error: "Le nom de la version est invalide." }, { status: 400 })
  }

  const owned = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, session.user.id)))
  if (owned.length === 0) {
    return Response.json({ error: "Document introuvable." }, { status: 404 })
  }

  const newName = typeof body.name === "string" ? body.name.trim() || null : null

  const [updated] = await db
    .update(documentVersions)
    .set({ name: newName })
    .where(
      and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId))
    )
    .returning({ id: documentVersions.id, name: documentVersions.name })

  if (!updated) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  return Response.json(updated)
}

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
    .returning({
      filePath: documentVersions.filePath,
      journalPath: documentVersions.journalPath,
    })

  if (!deleted) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  await rm(absoluteFilePath(deleted.filePath), { force: true })
  if (deleted.journalPath) {
    await rm(absoluteFilePath(deleted.journalPath), { force: true })
  }
  return Response.json({ ok: true })
}
