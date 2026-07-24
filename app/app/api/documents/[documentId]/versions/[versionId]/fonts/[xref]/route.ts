import { getOwnedVersion } from "@/lib/documents"
import { fetchPdfFont, PdfServiceError } from "@/lib/pdf-service"
import { getSession } from "@/lib/session"

/** Serves an embedded font (ttf/otf) of an owned version, for @font-face previews. */
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
    return Response.json({ error: "Référence de police invalide." }, { status: 400 })
  }

  const version = await getOwnedVersion(session.user.id, documentId, versionId)
  if (!version) {
    return Response.json({ error: "Version introuvable." }, { status: 404 })
  }

  try {
    const upstream = await fetchPdfFont(version.filePath, xrefNumber)
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "font/ttf",
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (error) {
    if (error instanceof PdfServiceError && error.status < 500) {
      return Response.json({ error: "Police introuvable." }, { status: 404 })
    }
    console.error("font: pdf-service unreachable", error)
    return Response.json({ error: "Service PDF indisponible." }, { status: 502 })
  }
}
