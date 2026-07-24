import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"

import { desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"
import { getOwnedVersion } from "@/lib/documents"
import { absoluteFilePath, versionRelativePath } from "@/lib/files"
import { exportPdf, PdfServiceError } from "@/lib/pdf-service"
import type { EditOperation } from "@/lib/pdf-structure"
import { getSession } from "@/lib/session"

const MAX_OPERATIONS = 500
// Replacement images travel base64-encoded in the journal (~4/3 overhead).
const MAX_IMAGE_BASE64_LENGTH = 20 * 1024 * 1024

function isValidOperation(op: unknown): op is EditOperation {
  if (typeof op !== "object" || op === null) return false
  const candidate = op as Record<string, unknown>
  if (
    candidate.type === "edit_text" &&
    typeof candidate.pageNumber === "number" &&
    typeof candidate.spanId === "string" &&
    Array.isArray(candidate.bbox) &&
    candidate.bbox.length === 4 &&
    Array.isArray(candidate.origin) &&
    candidate.origin.length === 2 &&
    typeof candidate.newText === "string" &&
    typeof candidate.font === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.color === "string" &&
    typeof candidate.bold === "boolean" &&
    typeof candidate.italic === "boolean"
  ) {
    return true
  }
  if (
    candidate.type === "delete_image" &&
    typeof candidate.pageNumber === "number" &&
    typeof candidate.imageId === "string" &&
    typeof candidate.xref === "number"
  ) {
    return true
  }
  if (
    candidate.type === "place_image" &&
    typeof candidate.pageNumber === "number" &&
    typeof candidate.imageId === "string" &&
    typeof candidate.xref === "number" &&
    Array.isArray(candidate.rect) &&
    candidate.rect.length === 4 &&
    candidate.rect.every((n) => typeof n === "number") &&
    (candidate.crop === null ||
      (Array.isArray(candidate.crop) &&
        candidate.crop.length === 4 &&
        candidate.crop.every((n) => typeof n === "number"))) &&
    (candidate.imageBase64 === null ||
      (typeof candidate.imageBase64 === "string" &&
        candidate.imageBase64.length > 0 &&
        candidate.imageBase64.length <= MAX_IMAGE_BASE64_LENGTH))
  ) {
    return true
  }
  return (
    candidate.type === "replace_image" &&
    typeof candidate.pageNumber === "number" &&
    typeof candidate.imageId === "string" &&
    typeof candidate.xref === "number" &&
    typeof candidate.imageBase64 === "string" &&
    candidate.imageBase64.length > 0 &&
    candidate.imageBase64.length <= MAX_IMAGE_BASE64_LENGTH
  )
}

/** Exports a new immutable version by replaying the edit journal on a source version. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId } = await params
  let body: { sourceVersionId?: unknown; operations?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Corps de requête invalide." }, { status: 400 })
  }

  if (typeof body.sourceVersionId !== "string" || !Array.isArray(body.operations)) {
    return Response.json({ error: "Corps de requête invalide." }, { status: 400 })
  }
  if (body.operations.length === 0) {
    return Response.json({ error: "Aucune modification à exporter." }, { status: 400 })
  }
  if (body.operations.length > MAX_OPERATIONS || !body.operations.every(isValidOperation)) {
    return Response.json({ error: "Journal de modifications invalide." }, { status: 400 })
  }

  const source = await getOwnedVersion(session.user.id, documentId, body.sourceVersionId)
  if (!source) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  const [latest] = await db
    .select({ versionNumber: documentVersions.versionNumber })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNumber))
    .limit(1)
  const nextVersionNumber = (latest?.versionNumber ?? 0) + 1

  const versionId = randomUUID()
  const targetPath = versionRelativePath(session.user.id, documentId, versionId)

  let pageCount: number
  try {
    const result = await exportPdf(source.filePath, targetPath, body.operations)
    pageCount = result.pageCount
  } catch (error) {
    if (error instanceof PdfServiceError && error.status < 500) {
      console.error("export rejected by pdf-service", error.message)
      return Response.json({ error: "Export impossible sur ce PDF." }, { status: 422 })
    }
    console.error("export: pdf-service unreachable", error)
    return Response.json({ error: "Service PDF indisponible, réessayez." }, { status: 502 })
  }

  const { size } = await stat(absoluteFilePath(targetPath))

  await db.transaction(async (tx) => {
    await tx.insert(documentVersions).values({
      id: versionId,
      documentId,
      versionNumber: nextVersionNumber,
      sourceVersionId: source.versionId,
      filePath: targetPath,
      fileSize: size,
      pageCount,
    })
    await tx
      .update(documents)
      .set({ updatedAt: new Date() })
      .where(eq(documents.id, documentId))
  })

  return Response.json(
    { versionId, versionNumber: nextVersionNumber, pageCount },
    { status: 201 }
  )
}
