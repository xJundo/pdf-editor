import { relations } from "drizzle-orm"
import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { user } from "./auth-schema"

export * from "./auth-schema"

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// Immutable versions: the imported original is version 0, every export adds
// a new row. sourceVersionId records which version an export was edited from.
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    name: text("name"),
    sourceVersionId: uuid("source_version_id"),
    filePath: text("file_path").notNull(),
    // Edit journal that produced this version, kept on the volume next to the
    // PDF (it embeds base64 images, which never belong in the database).
    // Replaying it on sourceVersionId restores the editor state that made it.
    journalPath: text("journal_path"),
    editCount: integer("edit_count"),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    pageCount: integer("page_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("document_versions_document_id_version_number_idx").on(
      table.documentId,
      table.versionNumber
    ),
  ]
)

export const documentsRelations = relations(documents, ({ many }) => ({
  versions: many(documentVersions),
}))

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}))
