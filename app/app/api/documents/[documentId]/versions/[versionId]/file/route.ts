import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"

import { getOwnedVersion } from "@/lib/documents"
import { absoluteFilePath } from "@/lib/files"
import { getSession } from "@/lib/session"

/** Serves the PDF inline for the pdf.js viewer (download route serves attachments). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId, versionId } = await params
  const version = await getOwnedVersion(session.user.id, documentId, versionId)
  if (!version) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  const filePath = absoluteFilePath(version.filePath)
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return Response.json({ error: "Fichier manquant sur le disque." }, { status: 404 })
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
  return new Response(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    },
  })
}
