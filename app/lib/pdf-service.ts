import "server-only"

const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL ?? "http://localhost:8000"

export class PdfServiceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export interface PdfInfo {
  pageCount: number
  encrypted: boolean
  metadata: Record<string, unknown>
}

async function callPdfService<T>(endpoint: string, relativePath: string): Promise<T> {
  const url = new URL(endpoint, PDF_SERVICE_URL)
  url.searchParams.set("path", relativePath)
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new PdfServiceError(`pdf-service: ${response.status} ${body}`, response.status)
  }
  return response.json()
}

/** Asks the pdf-service to open a stored PDF (path relative to FILES_ROOT). */
export async function getPdfInfo(relativePath: string): Promise<PdfInfo> {
  return callPdfService("/documents/info", relativePath)
}

/** Full editable structure (text spans + images) extracted by the pdf-service. */
export async function getPdfStructure(
  relativePath: string
): Promise<import("./pdf-structure").PdfStructure> {
  return callPdfService("/documents/structure", relativePath)
}

export interface ExportResult {
  pageCount: number
  deletedSignatureFields: number
}

/** Replays the edit journal on sourcePath and writes the result to targetPath. */
export async function exportPdf(
  sourcePath: string,
  targetPath: string,
  operations: import("./pdf-structure").EditOperation[]
): Promise<ExportResult> {
  const response = await fetch(new URL("/documents/export", PDF_SERVICE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, targetPath, operations }),
    cache: "no-store",
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new PdfServiceError(`pdf-service: ${response.status} ${body}`, response.status)
  }
  return response.json()
}
