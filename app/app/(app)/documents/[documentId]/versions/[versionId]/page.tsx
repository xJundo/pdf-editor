import { notFound } from "next/navigation"

import { PdfEditor } from "@/components/editor/pdf-editor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { getDocumentVersions, getOwnedVersion } from "@/lib/documents"
import { getPdfStructure } from "@/lib/pdf-service"
import type { PdfStructure } from "@/lib/pdf-structure"
import { requireSession } from "@/lib/session"

export default async function EditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentId: string; versionId: string }>
  searchParams: Promise<{ restore?: string }>
}) {
  const session = await requireSession()
  const { documentId, versionId } = await params
  // ?restore=<versionId>: reload that version's edit journal into the editor
  // (the journal is fetched client-side — it can carry base64 images).
  const { restore } = await searchParams

  const version = await getOwnedVersion(session.user.id, documentId, versionId)
  if (!version) {
    notFound()
  }

  const versions = await getDocumentVersions(session.user.id, documentId)

  let structure: PdfStructure
  try {
    structure = await getPdfStructure(version.filePath)
  } catch (error) {
    console.error("editor: structure extraction failed", error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Extraction impossible</AlertTitle>
        <AlertDescription>
          La structure de ce PDF n&apos;a pas pu être analysée. Réessayez plus tard.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <PdfEditor
      documentId={documentId}
      versionId={versionId}
      fileUrl={`/api/documents/${documentId}/versions/${versionId}/file`}
      structure={structure}
      documentName={version.name}
      versionNumber={version.versionNumber}
      restoreFromVersionId={restore ?? null}
      versions={versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        name: v.name,
        fileSize: Number(v.fileSize),
        pageCount: v.pageCount,
        sourceVersionId: v.sourceVersionId,
        editCount: v.editCount,
        createdAt: v.createdAt.toISOString(),
      }))}
    />
  )
}
