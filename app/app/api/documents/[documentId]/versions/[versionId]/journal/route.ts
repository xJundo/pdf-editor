import { readFile } from "node:fs/promises"

import { getOwnedVersion } from "@/lib/documents"
import { absoluteFilePath } from "@/lib/files"
import { getSession } from "@/lib/session"

/**
 * Serves the edit journal that produced a version.
 *
 * The editor replays it on the source version so a long series of edits can be
 * resumed and corrected instead of being redone from scratch.
 */
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
  if (!version.journalPath) {
    return Response.json(
      { error: "Aucun historique de modifications pour cette version." },
      { status: 404 }
    )
  }

  let payload: string
  try {
    payload = await readFile(absoluteFilePath(version.journalPath), "utf8")
  } catch (error) {
    console.error("journal: read failed", error)
    return Response.json(
      { error: "Aucun historique de modifications pour cette version." },
      { status: 404 }
    )
  }

  return new Response(payload, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  })
}
