import { rm } from "node:fs/promises"

import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents } from "@/db/schema"
import { documentDir } from "@/lib/files"
import { getSession } from "@/lib/session"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId } = await params
  const [deleted] = await db
    .delete(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, session.user.id)))
    .returning({ id: documents.id })

  if (!deleted) {
    return Response.json({ error: "Document introuvable." }, { status: 404 })
  }

  await rm(documentDir(session.user.id, documentId), { recursive: true, force: true })
  return Response.json({ ok: true })
}
