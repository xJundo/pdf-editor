"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  DownloadIcon,
  FileTextIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react"

import { UploadButton } from "@/components/documents/upload-button"
import type { DocumentItem, DocumentVersionItem } from "@/components/documents/types"
import { formatBytes, formatDate } from "@/components/documents/types"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/components/ui/toast"

function downloadUrl(documentId: string, versionId: string) {
  return `/api/documents/${documentId}/versions/${versionId}/download`
}

function editorUrl(documentId: string, versionId: string) {
  return `/documents/${documentId}/versions/${versionId}`
}

export function DocumentsView({ documents }: { documents: DocumentItem[] }) {
  const router = useRouter()
  const [versionsFor, setVersionsFor] = useState<DocumentItem | null>(null)
  const [deleteFor, setDeleteFor] = useState<DocumentItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteVersionFor, setDeleteVersionFor] = useState<DocumentVersionItem | null>(
    null
  )
  const [deletingVersion, setDeletingVersion] = useState(false)

  // Rename document state
  const [renameDocFor, setRenameDocFor] = useState<DocumentItem | null>(null)
  const [renameDocName, setRenameDocName] = useState("")
  const [renamingDoc, setRenamingDoc] = useState(false)

  // Rename version state
  const [renameVersionFor, setRenameVersionFor] = useState<DocumentVersionItem | null>(
    null
  )
  const [renameVersionName, setRenameVersionName] = useState("")
  const [renamingVersion, setRenamingVersion] = useState(false)

  async function handleRenameDoc() {
    if (!renameDocFor || !renameDocName.trim()) return
    setRenamingDoc(true)
    try {
      const response = await fetch(`/api/documents/${renameDocFor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameDocName.trim() }),
      })
      if (!response.ok) {
        toast.add({ type: "error", title: "Renommage impossible" })
        return
      }
      toast.add({ type: "success", title: "Document renommé" })
      setRenameDocFor(null)
      router.refresh()
    } finally {
      setRenamingDoc(false)
    }
  }

  async function handleRenameVersion() {
    if (!versionsFor || !renameVersionFor) return
    setRenamingVersion(true)
    try {
      const response = await fetch(
        `/api/documents/${versionsFor.id}/versions/${renameVersionFor.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: renameVersionName.trim() }),
        }
      )
      if (!response.ok) {
        toast.add({ type: "error", title: "Renommage de version impossible" })
        return
      }
      toast.add({ type: "success", title: "Version renommée" })
      const newName = renameVersionName.trim() || null
      setVersionsFor((current) =>
        current
          ? {
              ...current,
              versions: current.versions.map((v) =>
                v.id === renameVersionFor.id ? { ...v, name: newName } : v
              ),
            }
          : current
      )
      setRenameVersionFor(null)
      router.refresh()
    } finally {
      setRenamingVersion(false)
    }
  }

  async function handleDelete() {
    if (!deleteFor) return
    setDeleting(true)
    try {
      const response = await fetch(`/api/documents/${deleteFor.id}`, { method: "DELETE" })
      if (!response.ok) {
        toast.add({ type: "error", title: "Suppression impossible" })
        return
      }
      toast.add({ type: "success", title: `« ${deleteFor.name} » supprimé` })
      setDeleteFor(null)
      router.refresh()
    } finally {
      setDeleting(false)
    }
  }

  async function handleDeleteVersion() {
    if (!versionsFor || !deleteVersionFor) return
    setDeletingVersion(true)
    try {
      const response = await fetch(
        `/api/documents/${versionsFor.id}/versions/${deleteVersionFor.id}`,
        { method: "DELETE" }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        toast.add({
          type: "error",
          title: "Suppression impossible",
          description: data?.error,
        })
        return
      }
      toast.add({ type: "success", title: "Version supprimée" })
      setVersionsFor((current) =>
        current
          ? {
              ...current,
              versions: current.versions.filter((v) => v.id !== deleteVersionFor.id),
            }
          : current
      )
      setDeleteVersionFor(null)
      router.refresh()
    } finally {
      setDeletingVersion(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Mes documents</h1>
        <UploadButton />
      </div>

      {documents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Aucun document</EmptyTitle>
            <EmptyDescription>
              Importez un PDF pour commencer à l&apos;éditer.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead>Taille</TableHead>
                <TableHead>Versions</TableHead>
                <TableHead>Modifié le</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => {
                const latest = doc.versions[0]
                return (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-64 font-medium">
                      {latest ? (
                        <Link
                          href={editorUrl(doc.id, latest.id)}
                          className="block truncate hover:underline"
                        >
                          {doc.name}
                        </Link>
                      ) : (
                        <span className="block truncate">{doc.name}</span>
                      )}
                    </TableCell>
                    <TableCell>{latest?.pageCount ?? "—"}</TableCell>
                    <TableCell>{latest ? formatBytes(latest.fileSize) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{doc.versions.length}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(doc.updatedAt)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" />}
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                          <span className="sr-only">Actions pour {doc.name}</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            {latest ? (
                              <DropdownMenuItem
                                render={<Link href={editorUrl(doc.id, latest.id)} />}
                              >
                                <PencilIcon aria-hidden="true" />
                                Ouvrir dans l&apos;éditeur
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameDocFor(doc)
                                setRenameDocName(doc.name)
                              }}
                            >
                              <TagIcon aria-hidden="true" />
                              Renommer le document
                            </DropdownMenuItem>
                            {latest ? (
                              <DropdownMenuItem
                                render={
                                  <a href={downloadUrl(doc.id, latest.id)} download />
                                }
                              >
                                <DownloadIcon aria-hidden="true" />
                                Télécharger
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onClick={() => setVersionsFor(doc)}>
                              <HistoryIcon aria-hidden="true" />
                              Versions…
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteFor(doc)}
                            >
                              <Trash2Icon aria-hidden="true" />
                              Supprimer
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Rename Document Dialog */}
      <Dialog
        open={renameDocFor !== null}
        onOpenChange={(open) => {
          if (!open && !renamingDoc) setRenameDocFor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renommer le document</DialogTitle>
            <DialogDescription>
              Entrez le nouveau nom pour ce document.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleRenameDoc()
            }}
            className="flex flex-col gap-4"
          >
            <Input
              value={renameDocName}
              onChange={(e) => setRenameDocName(e.target.value)}
              placeholder="Nom du document"
              required
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renamingDoc}
                onClick={() => setRenameDocFor(null)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={renamingDoc || !renameDocName.trim()}>
                {renamingDoc ? <Spinner data-icon="inline-start" /> : null}
                Enregistrer
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Versions List Dialog */}
      <Dialog
        open={versionsFor !== null}
        onOpenChange={(open) => !open && setVersionsFor(null)}
      >
        {/* Widened for the same reason as the editor's version dialog: the
            4-button action group leaves the default sm width nothing to give. */}
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Versions de « {versionsFor?.name} »</DialogTitle>
            <DialogDescription>
              L&apos;original importé et chaque export forment une version.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {versionsFor?.versions.map((version) => (
              <div
                key={version.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {version.name
                        ? version.name
                        : version.versionNumber === 0
                          ? "Original"
                          : `Version ${version.versionNumber}`}
                    </span>
                    {version.name ? (
                      <Badge variant="secondary">v{version.versionNumber}</Badge>
                    ) : null}
                  </div>
                  <span className="truncate text-xs whitespace-nowrap text-muted-foreground">
                    {formatDate(version.createdAt)} · {formatBytes(version.fileSize)}
                    {version.pageCount !== null ? ` · ${version.pageCount} p.` : ""}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Renommer la version"
                    onClick={() => {
                      setRenameVersionFor(version)
                      setRenameVersionName(version.name || "")
                    }}
                  >
                    <TagIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <Link href={versionsFor ? editorUrl(versionsFor.id, version.id) : "#"} />
                    }
                  >
                    <PencilIcon data-icon="inline-start" aria-hidden="true" />
                    Ouvrir
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <a href={versionsFor ? downloadUrl(versionsFor.id, version.id) : "#"} download />
                    }
                  >
                    <DownloadIcon data-icon="inline-start" aria-hidden="true" />
                    Télécharger
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Supprimer la version"
                    disabled={(versionsFor?.versions.length ?? 0) <= 1}
                    onClick={() => setDeleteVersionFor(version)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Rename Version Dialog */}
      <Dialog
        open={renameVersionFor !== null}
        onOpenChange={(open) => {
          if (!open && !renamingVersion) setRenameVersionFor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renommer la version</DialogTitle>
            <DialogDescription>
              Donnez un nom personnalisé à cette version (ex : &quot;Version finale&quot;).
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleRenameVersion()
            }}
            className="flex flex-col gap-4"
          >
            <Input
              value={renameVersionName}
              onChange={(e) => setRenameVersionName(e.target.value)}
              placeholder={
                renameVersionFor?.versionNumber === 0
                  ? "Original"
                  : `Version ${renameVersionFor?.versionNumber}`
              }
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renamingVersion}
                onClick={() => setRenameVersionFor(null)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={renamingVersion}>
                {renamingVersion ? <Spinner data-icon="inline-start" /> : null}
                Enregistrer
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteFor !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteFor(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer « {deleteFor?.name} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le document et toutes ses versions seront définitivement supprimés.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Annuler</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
              {deleting ? <Spinner data-icon="inline-start" /> : null}
              Supprimer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteVersionFor !== null}
        onOpenChange={(open) => {
          if (!open && !deletingVersion) setDeleteVersionFor(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer{" "}
              {deleteVersionFor?.versionNumber === 0
                ? "l'original"
                : `la version ${deleteVersionFor?.versionNumber}`}{" "}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cette version sera définitivement supprimée. Les autres versions du
              document ne sont pas affectées.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingVersion}>Annuler</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deletingVersion}
              onClick={handleDeleteVersion}
            >
              {deletingVersion ? <Spinner data-icon="inline-start" /> : null}
              Supprimer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

