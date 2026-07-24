import { desc, eq } from "drizzle-orm"

import { DocumentsView } from "@/components/documents/documents-view"
import { db } from "@/db"
import { documents, documentVersions } from "@/db/schema"
import { requireSession } from "@/lib/session"

export default async function DocumentsPage() {
  const session = await requireSession()

  const rows = await db.query.documents.findMany({
    where: eq(documents.userId, session.user.id),
    orderBy: [desc(documents.updatedAt)],
    with: {
      versions: { orderBy: [desc(documentVersions.versionNumber)] },
    },
  })

  const items = rows.map((doc) => ({
    id: doc.id,
    name: doc.name,
    updatedAt: doc.updatedAt.toISOString(),
    versions: doc.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      fileSize: version.fileSize,
      pageCount: version.pageCount,
      createdAt: version.createdAt.toISOString(),
    })),
  }))

  return (
    <div className="flex flex-col gap-6">
      <DocumentsView documents={items} />
    </div>
  )
}
