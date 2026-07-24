export interface DocumentVersionItem {
  id: string
  versionNumber: number
  fileSize: number
  pageCount: number | null
  createdAt: string
}

export interface DocumentItem {
  id: string
  name: string
  updatedAt: string
  versions: DocumentVersionItem[]
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`
}

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
})

export function formatDate(iso: string) {
  return dateFormat.format(new Date(iso))
}
