"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { PDFDocumentProxy } from "pdfjs-dist"
import {
  ArrowLeftIcon,
  ImageIcon,
  ImageOffIcon,
  ImageUpIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  TypeIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type {
  EditOperation,
  PdfImage,
  PdfPageStructure,
  PdfSpan,
  PdfStructure,
} from "@/lib/pdf-structure"
import {
  buildDeleteImageOperation,
  buildReplaceImageOperation,
  buildTextEditOperation,
} from "@/lib/pdf-structure"

export type ImageEdit = { type: "delete" } | { type: "replace"; dataUrl: string }

const MAX_REPLACEMENT_IMAGE_BYTES = 15 * 1024 * 1024

interface Selection {
  pageIndex: number
  type: "span" | "image"
  id: string
}

/** CSS approximation of the detected PDF font, for the inline editing overlay. */
function cssFontFamily(font: string) {
  const name = font.toLowerCase()
  if (name.includes("courier") || name.includes("mono")) {
    return "ui-monospace, 'Courier New', monospace"
  }
  const serif =
    (name.includes("times") ||
      name.includes("serif") ||
      name.includes("roman") ||
      name.includes("georgia") ||
      name.includes("garamond")) &&
    !name.includes("sans")
  return serif ? "'Times New Roman', Georgia, serif" : "Helvetica, Arial, sans-serif"
}

function displayFontName(font: string) {
  // Embedded subset fonts are prefixed like "ABCDEF+Helvetica".
  const plus = font.indexOf("+")
  return plus === 6 ? font.slice(7) : font
}

export function PdfEditor({
  documentId,
  versionId,
  fileUrl,
  structure,
  documentName,
  versionNumber,
}: {
  documentId: string
  versionId: string
  fileUrl: string
  structure: PdfStructure
  documentName: string
  versionNumber: number
}) {
  const router = useRouter()
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [imageEdits, setImageEdits] = useState<Record<string, ImageEdit>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    let loadingTask: { destroy: () => Promise<void> } | null = null
    async function load() {
      try {
        const pdfjs = await import("pdfjs-dist")
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString()
        // wasmUrl: image decoders (qcms/openjpeg/jbig2) copied to public/
        // by scripts/copy-pdfjs-assets.mjs — without them pdf.js silently
        // drops ICC/JPX/JBIG2 images.
        const task = pdfjs.getDocument({ url: fileUrl, wasmUrl: "/pdfjs/wasm/" })
        loadingTask = task
        const doc = await task.promise
        if (!cancelled) setPdfDoc(doc)
      } catch (error) {
        console.error("pdf.js load failed", error)
        if (!cancelled) setLoadError(true)
      }
    }
    void load()
    return () => {
      cancelled = true
      void loadingTask?.destroy()
    }
  }, [fileUrl])

  const spanIndex = useMemo(() => {
    const index = new Map<string, { page: PdfPageStructure; span: PdfSpan }>()
    for (const page of structure.pages) {
      for (const span of page.spans) {
        index.set(span.id, { page, span })
      }
    }
    return index
  }, [structure])

  const imageIndex = useMemo(() => {
    const index = new Map<string, { page: PdfPageStructure; image: PdfImage }>()
    for (const page of structure.pages) {
      for (const image of page.images) {
        index.set(image.id, { page, image })
      }
    }
    return index
  }, [structure])

  const selected = useMemo(() => {
    if (!selection) return null
    const page = structure.pages[selection.pageIndex]
    if (!page) return null
    if (selection.type === "span") {
      const span = page.spans.find((s) => s.id === selection.id)
      return span ? { type: "span" as const, span } : null
    }
    const image = page.images.find((i) => i.id === selection.id)
    return image ? { type: "image" as const, image } : null
  }, [selection, structure])

  const editCount = Object.keys(edits).length + Object.keys(imageEdits).length

  function setImageEdit(imageId: string, edit: ImageEdit) {
    setImageEdits((current) => ({ ...current, [imageId]: edit }))
  }

  function revertImageEdit(imageId: string) {
    setImageEdits((current) => {
      const next = { ...current }
      delete next[imageId]
      return next
    })
  }

  function replaceImage(imageId: string, file: File) {
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast.add({
        type: "error",
        title: "Format non pris en charge",
        description: "Utilisez une image PNG ou JPEG.",
      })
      return
    }
    if (file.size > MAX_REPLACEMENT_IMAGE_BYTES) {
      toast.add({
        type: "error",
        title: "Image trop volumineuse",
        description: "15 Mo maximum.",
      })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setImageEdit(imageId, { type: "replace", dataUrl: reader.result })
      }
    }
    reader.readAsDataURL(file)
  }

  function commitEdit(span: PdfSpan, draft: string) {
    setEdits((current) => {
      const next = { ...current }
      if (draft === span.text) {
        delete next[span.id]
      } else {
        next[span.id] = draft
      }
      return next
    })
    setEditingId(null)
  }

  function revertEdit(spanId: string) {
    setEdits((current) => {
      const next = { ...current }
      delete next[spanId]
      return next
    })
    if (editingId === spanId) setEditingId(null)
  }

  async function handleExport() {
    if (editCount === 0 || exporting) return
    setExporting(true)
    try {
      const operations: EditOperation[] = Object.entries(edits).map(
        ([spanId, newText]) => {
          const entry = spanIndex.get(spanId)
          if (!entry) throw new Error(`unknown span ${spanId}`)
          return buildTextEditOperation(entry.page.number, entry.span, newText)
        }
      )
      for (const [imageId, edit] of Object.entries(imageEdits)) {
        const entry = imageIndex.get(imageId)
        if (!entry) throw new Error(`unknown image ${imageId}`)
        operations.push(
          edit.type === "delete"
            ? buildDeleteImageOperation(entry.page.number, entry.image)
            : buildReplaceImageOperation(
                entry.page.number,
                entry.image,
                edit.dataUrl.slice(edit.dataUrl.indexOf(",") + 1)
              )
        )
      }
      const response = await fetch(`/api/documents/${documentId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceVersionId: versionId, operations }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        toast.add({
          type: "error",
          title: "Export impossible",
          description: data?.error ?? "Une erreur est survenue.",
        })
        return
      }
      const data = await response.json()
      toast.add({
        type: "success",
        title: `Version ${data.versionNumber} créée`,
        description: "La nouvelle version est ouverte dans l'éditeur.",
      })
      router.push(`/documents/${documentId}/versions/${data.versionId}`)
      router.refresh()
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/documents" />}
        >
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
          Mes documents
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <h1 className="min-w-0 truncate text-base font-semibold">{documentName}</h1>
        <Badge variant="secondary">
          {versionNumber === 0 ? "Original" : `Version ${versionNumber}`}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {structure.pageCount} page{structure.pageCount > 1 ? "s" : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {editCount > 0 ? (
            <span className="text-sm text-muted-foreground">
              {editCount} modification{editCount > 1 ? "s" : ""}
            </span>
          ) : null}
          <Button onClick={handleExport} disabled={editCount === 0 || exporting}>
            {exporting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" aria-hidden="true" />
            )}
            Exporter
          </Button>
        </div>
      </div>

      {loadError ? (
        <p className="text-sm text-destructive">
          Le PDF n&apos;a pas pu être affiché dans le navigateur.
        </p>
      ) : (
        <div className="flex items-start gap-6">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
            {structure.pages.map((page) => (
              <PdfPageView
                key={page.number}
                pdfDoc={pdfDoc}
                page={page}
                selection={selection}
                edits={edits}
                imageEdits={imageEdits}
                editingId={editingId}
                onSelect={setSelection}
                onStartEdit={(id) => setEditingId(id)}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEditingId(null)}
              />
            ))}
          </div>
          <aside className="sticky top-6 hidden w-72 shrink-0 flex-col gap-4 lg:flex">
            <SelectionPanel
              selected={selected}
              edits={edits}
              imageEdits={imageEdits}
              onRevert={revertEdit}
              onReplaceImage={replaceImage}
              onDeleteImage={(imageId) => setImageEdit(imageId, { type: "delete" })}
              onRevertImage={revertImageEdit}
            />
            {editCount > 0 ? (
              <EditsPanel
                edits={edits}
                imageEdits={imageEdits}
                spanIndex={spanIndex}
                imageIndex={imageIndex}
                onRevert={revertEdit}
                onRevertImage={revertImageEdit}
              />
            ) : null}
          </aside>
        </div>
      )}
    </div>
  )
}

function PdfPageView({
  pdfDoc,
  page,
  selection,
  edits,
  imageEdits,
  editingId,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: {
  pdfDoc: PDFDocumentProxy | null
  page: PdfPageStructure
  selection: Selection | null
  edits: Record<string, string>
  imageEdits: Record<string, ImageEdit>
  editingId: string | null
  onSelect: (selection: Selection) => void
  onStartEdit: (spanId: string) => void
  onCommitEdit: (span: PdfSpan, draft: string) => void
  onCancelEdit: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  const [pxWidth, setPxWidth] = useState(0)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setPxWidth(width)
    })
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null

    async function render() {
      const pdfPage = await pdfDoc!.getPage(page.number + 1)
      const canvas = canvasRef.current
      if (!canvas || cancelled) return
      const scale = 1.5 * Math.min(window.devicePixelRatio || 1, 2)
      const viewport = pdfPage.getViewport({ scale })
      canvas.width = viewport.width
      canvas.height = viewport.height
      renderTask = pdfPage.render({ canvas, viewport })
      try {
        await renderTask.promise
        if (!cancelled) setRendered(true)
      } catch {
        // Render cancelled on unmount: nothing to do.
      }
    }
    void render()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pdfDoc, page.number])

  // Display scale: CSS px per PDF point, for font sizing in overlays.
  const scale = pxWidth > 0 ? pxWidth / page.width : 0

  function toPercent(bbox: [number, number, number, number]) {
    return {
      left: `${(bbox[0] / page.width) * 100}%`,
      top: `${(bbox[1] / page.height) * 100}%`,
      width: `${((bbox[2] - bbox[0]) / page.width) * 100}%`,
      height: `${((bbox[3] - bbox[1]) / page.height) * 100}%`,
    }
  }

  function spanTextStyle(span: PdfSpan): React.CSSProperties {
    return {
      fontSize: span.size * scale,
      lineHeight: `${(span.bbox[3] - span.bbox[1]) * scale}px`,
      fontFamily: cssFontFamily(span.font),
      fontWeight: span.bold ? 700 : 400,
      fontStyle: span.italic ? "italic" : "normal",
      color: span.color,
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative w-full max-w-3xl overflow-hidden rounded-md border bg-white shadow-sm"
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      data-page={page.number}
    >
      {!rendered ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {page.spans.map((span) => {
        const edited = span.id in edits
        const effectiveText = edited ? edits[span.id] : span.text
        if (editingId === span.id && scale > 0) {
          return (
            <SpanEditor
              key={span.id}
              span={span}
              initialValue={effectiveText}
              style={{ ...toPercent(span.bbox), ...spanTextStyle(span) }}
              onCommit={onCommitEdit}
              onCancel={onCancelEdit}
            />
          )
        }
        return (
          <button
            key={span.id}
            type="button"
            title={effectiveText}
            aria-label={`Texte : ${effectiveText}`}
            className={cn(
              "absolute cursor-text rounded-xs text-left whitespace-nowrap",
              edited ? "bg-white" : "bg-transparent text-transparent",
              selection?.type === "span" &&
                selection.id === span.id &&
                selection.pageIndex === page.number
                ? "ring-2 ring-primary"
                : edited
                  ? "ring-1 ring-primary/40 hover:ring-2 hover:ring-primary/60"
                  : "hover:bg-primary/5 hover:ring-2 hover:ring-primary/40"
            )}
            style={{
              ...toPercent(span.bbox),
              ...(edited && scale > 0 ? spanTextStyle(span) : {}),
            }}
            onClick={() => {
              onSelect({ pageIndex: page.number, type: "span", id: span.id })
              onStartEdit(span.id)
            }}
          >
            {edited && scale > 0 ? edits[span.id] : null}
          </button>
        )
      })}
      {page.images.map((image) => {
        const edit = imageEdits[image.id]
        const isSelected =
          selection?.type === "image" &&
          selection.id === image.id &&
          selection.pageIndex === page.number
        return (
          <button
            key={image.id}
            type="button"
            aria-label={
              edit?.type === "delete"
                ? "Image supprimée"
                : edit?.type === "replace"
                  ? "Image remplacée"
                  : "Image"
            }
            className={cn(
              "absolute cursor-pointer overflow-hidden rounded-xs",
              edit?.type === "delete" && "bg-white",
              isSelected
                ? "ring-2 ring-chart-2"
                : edit
                  ? "ring-1 ring-chart-2/60 hover:ring-2 hover:ring-chart-2"
                  : "hover:bg-chart-2/10 hover:ring-2 hover:ring-chart-2/50"
            )}
            style={toPercent(image.bbox)}
            onClick={() =>
              onSelect({ pageIndex: page.number, type: "image", id: image.id })
            }
          >
            {edit?.type === "replace" ? (
              // Stretched into the original bbox, exactly like the export does.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={edit.dataUrl}
                alt="Aperçu du remplacement"
                className="size-full"
                style={{ objectFit: "fill" }}
              />
            ) : null}
            {edit?.type === "delete" ? (
              <span className="flex size-full items-center justify-center border border-dashed border-muted-foreground/40">
                <ImageOffIcon
                  className="size-4 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function SpanEditor({
  span,
  initialValue,
  style,
  onCommit,
  onCancel,
}: {
  span: PdfSpan
  initialValue: string
  style: React.CSSProperties
  onCommit: (span: PdfSpan, draft: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(initialValue)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label="Modifier le texte"
      className="absolute z-10 min-w-24 rounded-xs bg-white p-0 ring-2 ring-primary outline-none"
      style={style}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(span, draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          onCommit(span, draft)
        } else if (event.key === "Escape") {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function SelectionPanel({
  selected,
  edits,
  imageEdits,
  onRevert,
  onReplaceImage,
  onDeleteImage,
  onRevertImage,
}: {
  selected: { type: "span"; span: PdfSpan } | { type: "image"; image: PdfImage } | null
  edits: Record<string, string>
  imageEdits: Record<string, ImageEdit>
  onRevert: (spanId: string) => void
  onReplaceImage: (imageId: string, file: File) => void
  onDeleteImage: (imageId: string) => void
  onRevertImage: (imageId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sélection</CardTitle>
        <CardDescription>
          {selected
            ? "Style détecté de l'élément sélectionné"
            : "Cliquez sur un texte pour le modifier"}
        </CardDescription>
      </CardHeader>
      {selected ? (
        <CardContent className="flex flex-col gap-3 text-sm">
          {selected.type === "span" ? (
            <>
              <p className="flex items-center gap-2 font-medium">
                <TypeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                Texte
              </p>
              <p className="line-clamp-3 rounded-md bg-muted px-2 py-1.5">
                {edits[selected.span.id] ?? selected.span.text}
              </p>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Police</dt>
                <dd className="truncate">{displayFontName(selected.span.font)}</dd>
                <dt className="text-muted-foreground">Taille</dt>
                <dd>{Math.round(selected.span.size * 10) / 10} pt</dd>
                <dt className="text-muted-foreground">Couleur</dt>
                <dd className="flex items-center gap-2">
                  <span
                    className="size-3.5 rounded-xs border"
                    style={{ backgroundColor: selected.span.color }}
                  />
                  {selected.span.color}
                </dd>
              </dl>
              {selected.span.bold || selected.span.italic ? (
                <div className="flex gap-1.5">
                  {selected.span.bold ? <Badge variant="secondary">Gras</Badge> : null}
                  {selected.span.italic ? (
                    <Badge variant="secondary">Italique</Badge>
                  ) : null}
                </div>
              ) : null}
              {selected.span.id in edits ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRevert(selected.span.id)}
                >
                  <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                  Rétablir le texte d&apos;origine
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium">
                <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                Image
                {imageEdits[selected.image.id] ? (
                  <Badge variant="secondary">
                    {imageEdits[selected.image.id].type === "delete"
                      ? "Supprimée"
                      : "Remplacée"}
                  </Badge>
                ) : null}
              </p>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Largeur</dt>
                <dd>{Math.round(selected.image.bbox[2] - selected.image.bbox[0])} pt</dd>
                <dt className="text-muted-foreground">Hauteur</dt>
                <dd>{Math.round(selected.image.bbox[3] - selected.image.bbox[1])} pt</dd>
              </dl>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onReplaceImage(selected.image.id, file)
                  event.target.value = ""
                }}
              />
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageUpIcon data-icon="inline-start" aria-hidden="true" />
                  Remplacer l&apos;image…
                </Button>
                {imageEdits[selected.image.id] ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRevertImage(selected.image.id)}
                  >
                    <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                    Rétablir l&apos;image d&apos;origine
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => onDeleteImage(selected.image.id)}
                  >
                    <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                    Supprimer l&apos;image
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                L&apos;image de remplacement est redimensionnée dans le cadre
                d&apos;origine.
              </p>
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  )
}

function EditsPanel({
  edits,
  imageEdits,
  spanIndex,
  imageIndex,
  onRevert,
  onRevertImage,
}: {
  edits: Record<string, string>
  imageEdits: Record<string, ImageEdit>
  spanIndex: Map<string, { page: PdfPageStructure; span: PdfSpan }>
  imageIndex: Map<string, { page: PdfPageStructure; image: PdfImage }>
  onRevert: (spanId: string) => void
  onRevertImage: (imageId: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifications</CardTitle>
        <CardDescription>Appliquées au PDF lors de l&apos;export</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {Object.entries(edits).map(([spanId, newText]) => {
          const entry = spanIndex.get(spanId)
          if (!entry) return null
          return (
            <div
              key={spanId}
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-muted-foreground line-through">
                  {entry.span.text}
                </span>
                <span className="truncate">
                  {newText || <em className="text-muted-foreground">(supprimé)</em>}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRevert(spanId)}
                aria-label="Rétablir"
              >
                <RotateCcwIcon aria-hidden="true" />
              </Button>
            </div>
          )
        })}
        {Object.entries(imageEdits).map(([imageId, edit]) => {
          const entry = imageIndex.get(imageId)
          if (!entry) return null
          return (
            <div
              key={imageId}
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                {edit.type === "replace" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={edit.dataUrl}
                    alt=""
                    className="size-8 shrink-0 rounded-xs border object-cover"
                  />
                ) : (
                  <ImageOffIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">
                  Image p.{entry.page.number + 1} ·{" "}
                  {edit.type === "delete" ? "supprimée" : "remplacée"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRevertImage(imageId)}
                aria-label="Rétablir"
              >
                <RotateCcwIcon aria-hidden="true" />
              </Button>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
