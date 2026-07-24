import { getOwnedVersion } from "@/lib/documents"
import { fetchPdfImage, PdfServiceError } from "@/lib/pdf-service"
import { getSession } from "@/lib/session"

/** Serves a single embedded image (PNG) of an owned version, for editor previews. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string; xref: string }> }
) {
  const session = await getSession()
  if (!session) {
    return Response.json({ error: "Non authentifié." }, { status: 401 })
  }

  const { documentId, versionId, xref } = await params
  const xrefNumber = Number(xref)
  if (!Number.isInteger(xrefNumber) || xrefNumber <= 0) {
    return Response.json({ error: "Référence d'image invalide." }, { status: 400 })
  }

  const version = await getOwnedVersion(session.user.id, documentId, versionId)
  if (!version) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  try {
    const upstream = await fetchPdfImage(version.filePath, xrefNumber)
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (error) {
    if (error instanceof PdfServiceError && error.status < 500) {
      return Response.json({ error: "Image introuvable." }, { status: 404 })
    }
    console.error("image: pdf-service unreachable", error)
    return Response.json({ error: "Service PDF indisponible." }, { status: 502 })
  }
}
