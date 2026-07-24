import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"
import { absoluteFilePath, documentDir, ensureDir, versionRelativePath } from "@/lib/files"
import { getPdfInfo, PdfServiceError } from "@/lib/pdf-service"
import { getSession } from "@/lib/session"

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (contentLength > MAX_UPLOAD_BYTES + 4096) {
    return Response.json(
      { error: `Fichier trop volumineux (maximum ${process.env.MAX_UPLOAD_MB ?? 50} Mo).` },
      { status: 413 }
    )
  }

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return Response.json({ error: "Aucun fichier reçu." }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `Fichier trop volumineux (maximum ${process.env.MAX_UPLOAD_MB ?? 50} Mo).` },
      { status: 413 }
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  // A real PDF starts with %PDF- within the first 1024 bytes (some tools
  // prepend junk); checking magic bytes beats trusting the MIME type.
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024))
  if (!header.includes("%PDF-")) {
    return Response.json({ error: "Ce fichier n'est pas un PDF valide." }, { status: 422 })
  }

  const userId = session.user.id
  const documentId = randomUUID()
  const versionId = randomUUID()
  const relativePath = versionRelativePath(userId, documentId, versionId)

  await ensureDir(documentDir(userId, documentId))
  await writeFile(absoluteFilePath(relativePath), bytes)

  let pageCount: number
  try {
    const info = await getPdfInfo(relativePath)
    pageCount = info.pageCount
  } catch (error) {
    await rm(documentDir(userId, documentId), { recursive: true, force: true })
    if (error instanceof PdfServiceError && error.status < 500) {
      return Response.json(
        { error: "Ce fichier n'a pas pu être ouvert comme un PDF." },
        { status: 422 }
      )
    }
    console.error("upload: pdf-service unreachable", error)
    return Response.json({ error: "Service PDF indisponible, réessayez." }, { status: 502 })
  }

  const name = file.name.replace(/\.pdf$/i, "") || "Document"
  await db.transaction(async (tx) => {
    await tx.insert(documents).values({ id: documentId, userId, name })
    await tx.insert(documentVersions).values({
      id: versionId,
      documentId,
      versionNumber: 0,
      filePath: relativePath,
      fileSize: file.size,
      pageCount,
    })
  })

  return Response.json({ id: documentId, name, pageCount }, { status: 201 })
}
