"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { PDFDocumentProxy } from "pdfjs-dist"
import {
  ArrowLeftIcon,
  CropIcon,
  DownloadIcon,
  HistoryIcon,
  ImageIcon,
  ImageOffIcon,
  ImageUpIcon,
  MoveIcon,
  PencilIcon,
  RotateCcwIcon,
  SaveIcon,
  TagIcon,
  Trash2Icon,
  TypeIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type {
  BBox,
  Crop,
  EditOperation,
  PdfImage,
  PdfPageStructure,
  PdfSpan,
  PdfStructure,
  SpanBox,
} from "@/lib/pdf-structure"
import {
  buildDeleteImageOperation,
  buildPlaceImageOperation,
  buildTextEditOperation,
} from "@/lib/pdf-structure"

/** delete = removed; transform = moved/resized/cropped, optionally replaced. */
export type ImageEdit =
  | { type: "delete" }
  | { type: "transform"; bbox: BBox; crop: Crop | null; dataUrl: string | null }

const MAX_REPLACEMENT_IMAGE_BYTES = 15 * 1024 * 1024
const MIN_BOX_PT = 8

const BASE_PAGE_WIDTH = 768 // px at zoom = 1 (matches the former max-w-3xl)
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

export interface VersionSummary {
  id: string
  versionNumber: number
  name?: string | null
  fileSize: number
  pageCount: number | null
  createdAt: string
}

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

/** Real embedded font (via @font-face) when available, heuristic fallback otherwise. */
function spanFontFamily(span: PdfSpan): string {
  const fallback = cssFontFamily(span.font)
  return span.fontFile != null ? `"pdffont-${span.fontFile}", ${fallback}` : fallback
}

// --- Geometry helpers (PDF points, top-left origin) ----------------------

const RESIZE_HANDLES = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
] as const

function bboxToPercent(bbox: BBox, pageWidth: number, pageHeight: number) {
  return {
    left: `${(bbox[0] / pageWidth) * 100}%`,
    top: `${(bbox[1] / pageHeight) * 100}%`,
    width: `${((bbox[2] - bbox[0]) / pageWidth) * 100}%`,
    height: `${((bbox[3] - bbox[1]) / pageHeight) * 100}%`,
  }
}

/** Tracks a pointer drag inside the page wrapper, reporting PDF-point deltas. */
function beginPointerDrag(
  event: React.PointerEvent,
  pageWidth: number,
  pageHeight: number,
  onMove: (dx: number, dy: number) => void
) {
  const wrapper = (event.currentTarget as HTMLElement).closest(
    "[data-page]"
  ) as HTMLElement | null
  if (!wrapper) return
  event.preventDefault()
  event.stopPropagation()
  const rect = wrapper.getBoundingClientRect()
  const toPdf = (cx: number, cy: number): [number, number] => [
    ((cx - rect.left) / rect.width) * pageWidth,
    ((cy - rect.top) / rect.height) * pageHeight,
  ]
  const [sx, sy] = toPdf(event.clientX, event.clientY)
  const move = (ev: PointerEvent) => {
    const [x, y] = toPdf(ev.clientX, ev.clientY)
    onMove(x - sx, y - sy)
  }
  const up = () => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
}

function moveBbox(b: BBox, dx: number, dy: number, pw: number, ph: number): BBox {
  const w = b[2] - b[0]
  const h = b[3] - b[1]
  const x0 = Math.max(0, Math.min(pw - w, b[0] + dx))
  const y0 = Math.max(0, Math.min(ph - h, b[1] + dy))
  return [x0, y0, x0 + w, y0 + h]
}

function resizeBbox(
  b: BBox,
  handle: string,
  dx: number,
  dy: number,
  pw: number,
  ph: number
): BBox {
  let [x0, y0, x1, y1] = b
  if (handle.includes("w")) x0 = Math.max(0, Math.min(x1 - MIN_BOX_PT, x0 + dx))
  if (handle.includes("e")) x1 = Math.min(pw, Math.max(x0 + MIN_BOX_PT, x1 + dx))
  if (handle.includes("n")) y0 = Math.max(0, Math.min(y1 - MIN_BOX_PT, y0 + dy))
  if (handle.includes("s")) y1 = Math.min(ph, Math.max(y0 + MIN_BOX_PT, y1 + dy))
  return [x0, y0, x1, y1]
}

function resizeCrop(c: Crop, handle: string, dfx: number, dfy: number): Crop {
  const MIN = 0.05
  const next = { ...c }
  if (handle.includes("w")) next.left = Math.max(0, Math.min(next.right - MIN, c.left + dfx))
  if (handle.includes("e"))
    next.right = Math.min(1, Math.max(next.left + MIN, c.right + dfx))
  if (handle.includes("n")) next.top = Math.max(0, Math.min(next.bottom - MIN, c.top + dfy))
  if (handle.includes("s"))
    next.bottom = Math.min(1, Math.max(next.top + MIN, c.bottom + dfy))
  return next
}

/** Background style showing the kept crop region stretched to fill the box. */
function cropFillStyle(src: string, crop: Crop | null): React.CSSProperties {
  if (!crop) {
    return {
      backgroundImage: `url(${src})`,
      backgroundSize: "100% 100%",
      backgroundRepeat: "no-repeat",
    }
  }
  const w = crop.right - crop.left
  const h = crop.bottom - crop.top
  const posX = w >= 1 ? 0 : (crop.left / (1 - w)) * 100
  const posY = h >= 1 ? 0 : (crop.top / (1 - h)) * 100
  return {
    backgroundImage: `url(${src})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${100 / w}% ${100 / h}%`,
    backgroundPosition: `${posX}% ${posY}%`,
  }
}

export function PdfEditor({
  documentId,
  versionId,
  fileUrl,
  structure,
  documentName,
  versionNumber,
  versions,
}: {
  documentId: string
  versionId: string
  fileUrl: string
  structure: PdfStructure
  documentName: string
  versionNumber: number
  versions: VersionSummary[]
}) {
  const router = useRouter()
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [spanBoxes, setSpanBoxes] = useState<Record<string, SpanBox>>({})
  const [imageEdits, setImageEdits] = useState<Record<string, ImageEdit>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [croppingId, setCroppingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [fontsReady, setFontsReady] = useState(structure.fonts.length === 0)
  const [versionList, setVersionList] = useState(versions)

  const [currentDocName, setCurrentDocName] = useState(documentName)
  const [renameDocOpen, setRenameDocOpen] = useState(false)
  const [renameDocInput, setRenameDocInput] = useState("")
  const [renamingDoc, setRenamingDoc] = useState(false)

  async function handleRenameDoc() {
    if (!renameDocInput.trim()) return
    setRenamingDoc(true)
    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameDocInput.trim() }),
      })
      if (!response.ok) {
        toast.add({ type: "error", title: "Renommage impossible" })
        return
      }
      toast.add({ type: "success", title: "Document renommé" })
      setCurrentDocName(renameDocInput.trim())
      setRenameDocOpen(false)
      router.refresh()
    } finally {
      setRenamingDoc(false)
    }
  }

  function imageSrc(xref: number) {
    return `/api/documents/${documentId}/versions/${versionId}/images/${xref}`
  }

  // Expose the PDF's own embedded fonts to the preview via @font-face.
  const fontFaceCss = useMemo(
    () =>
      structure.fonts
        .map(
          (f) =>
            `@font-face{font-family:"pdffont-${f.xref}";` +
            `src:url("/api/documents/${documentId}/versions/${versionId}/fonts/${f.xref}") ` +
            `format("${f.format}");font-display:swap;}`
        )
        .join("\n"),
    [structure.fonts, documentId, versionId]
  )

  // "Identification des polices…" until the embedded fonts have loaded
  // (initial state already handles the no-embedded-fonts case).
  useEffect(() => {
    if (structure.fonts.length === 0) return
    let cancelled = false
    const families = structure.fonts.map((f) => `16px "pdffont-${f.xref}"`)
    Promise.race([
      Promise.all(families.map((f) => document.fonts.load(f))).then(() =>
        document.fonts.ready
      ),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]).finally(() => {
      if (!cancelled) setFontsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [structure.fonts])

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

  const modifiedSpanIds = useMemo(
    () => new Set([...Object.keys(edits), ...Object.keys(spanBoxes)]),
    [edits, spanBoxes]
  )
  const editCount = modifiedSpanIds.size + Object.keys(imageEdits).length

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
      toast.add({ type: "error", title: "Image trop volumineuse", description: "15 Mo maximum." })
      return
    }
    const entry = imageIndex.get(imageId)
    if (!entry) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== "string") return
      setImageEdits((current) => {
        const prev = current[imageId]
        const base: BBox =
          prev && prev.type === "transform" ? prev.bbox : entry.image.bbox
        const crop = prev && prev.type === "transform" ? prev.crop : null
        return {
          ...current,
          [imageId]: { type: "transform", bbox: base, crop, dataUrl: reader.result as string },
        }
      })
    }
    reader.readAsDataURL(file)
  }

  function transformImage(imageId: string, bbox: BBox) {
    const entry = imageIndex.get(imageId)
    if (!entry) return
    setImageEdits((current) => {
      const prev = current[imageId]
      const crop = prev && prev.type === "transform" ? prev.crop : null
      const dataUrl = prev && prev.type === "transform" ? prev.dataUrl : null
      return { ...current, [imageId]: { type: "transform", bbox, crop, dataUrl } }
    })
  }

  function cropImage(imageId: string, crop: Crop) {
    const entry = imageIndex.get(imageId)
    if (!entry) return
    setImageEdits((current) => {
      const prev = current[imageId]
      const bbox = prev && prev.type === "transform" ? prev.bbox : entry.image.bbox
      const dataUrl = prev && prev.type === "transform" ? prev.dataUrl : null
      return { ...current, [imageId]: { type: "transform", bbox, crop, dataUrl } }
    })
  }

  function ensureTransform(imageId: string) {
    const entry = imageIndex.get(imageId)
    if (!entry) return
    setImageEdits((current) => {
      const prev = current[imageId]
      if (prev && prev.type === "transform") return current
      return {
        ...current,
        [imageId]: { type: "transform", bbox: entry.image.bbox, crop: null, dataUrl: null },
      }
    })
  }

  function deleteImage(imageId: string) {
    setImageEdits((current) => ({ ...current, [imageId]: { type: "delete" } }))
    if (croppingId === imageId) setCroppingId(null)
  }

  function revertImageEdit(imageId: string) {
    setImageEdits((current) => {
      const next = { ...current }
      delete next[imageId]
      return next
    })
    if (croppingId === imageId) setCroppingId(null)
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

  function resizeSpanBox(span: PdfSpan, bbox: BBox) {
    const ow = span.bbox[2] - span.bbox[0]
    const oh = span.bbox[3] - span.bbox[1]
    const nw = bbox[2] - bbox[0]
    const nh = bbox[3] - bbox[1]
    const ratioX = ow > 0 ? (span.origin[0] - span.bbox[0]) / ow : 0
    const ratioY = oh > 0 ? (span.origin[1] - span.bbox[1]) / oh : 1
    const size = oh > 0 ? span.size * (nh / oh) : span.size
    const origin: [number, number] = [bbox[0] + ratioX * nw, bbox[1] + ratioY * nh]
    setSpanBoxes((current) => ({ ...current, [span.id]: { bbox, origin, size } }))
  }

  function revertSpan(spanId: string) {
    setEdits((current) => {
      const next = { ...current }
      delete next[spanId]
      return next
    })
    setSpanBoxes((current) => {
      const next = { ...current }
      delete next[spanId]
      return next
    })
    if (editingId === spanId) setEditingId(null)
  }

  function goToElement(sel: Selection) {
    setSelection(sel)
    setCroppingId(null)
    if (sel.type === "span") setEditingId(sel.id)
    // Scroll the page into view; the element highlight guides the eye.
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-page="${sel.pageIndex}"]`)
      el?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }

  async function handleExport() {
    if (editCount === 0 || exporting) return
    setExporting(true)
    try {
      const operations: EditOperation[] = []
      for (const spanId of modifiedSpanIds) {
        const entry = spanIndex.get(spanId)
        if (!entry) throw new Error(`unknown span ${spanId}`)
        const newText = spanId in edits ? edits[spanId] : entry.span.text
        operations.push(
          buildTextEditOperation(entry.page.number, entry.span, newText, spanBoxes[spanId])
        )
      }
      for (const [imageId, edit] of Object.entries(imageEdits)) {
        const entry = imageIndex.get(imageId)
        if (!entry) throw new Error(`unknown image ${imageId}`)
        if (edit.type === "delete") {
          operations.push(buildDeleteImageOperation(entry.page.number, entry.image))
        } else {
          const base64 = edit.dataUrl
            ? edit.dataUrl.slice(edit.dataUrl.indexOf(",") + 1)
            : null
          operations.push(
            buildPlaceImageOperation(
              entry.page.number,
              entry.image,
              edit.bbox,
              edit.crop,
              base64
            )
          )
        }
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
      // Auto-download the freshly created version, then open it in the editor.
      triggerDownload(
        `/api/documents/${documentId}/versions/${data.versionId}/download`
      )
      toast.add({
        type: "success",
        title: `Version ${data.versionNumber} créée`,
        description: "Le fichier est téléchargé et ouvert dans l'éditeur.",
      })
      router.push(`/documents/${documentId}/versions/${data.versionId}`)
      router.refresh()
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {fontFaceCss ? (
        <style dangerouslySetInnerHTML={{ __html: fontFaceCss }} />
      ) : null}
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
        <div className="flex items-center gap-1 min-w-0">
          <h1 className="min-w-0 truncate text-base font-semibold">{currentDocName}</h1>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Renommer le document"
            onClick={() => {
              setRenameDocInput(currentDocName)
              setRenameDocOpen(true)
            }}
          >
            <TagIcon aria-hidden="true" />
          </Button>
        </div>
        <Badge variant="secondary">
          {versionNumber === 0 ? "Original" : `Version ${versionNumber}`}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {structure.pageCount} page{structure.pageCount > 1 ? "s" : ""}
        </span>
        {!fontsReady ? (
          <span
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
            data-testid="fonts-loading"
          >
            <Spinner className="size-3.5" />
            Identification des polices…
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dézoomer"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
            >
              <ZoomOutIcon aria-hidden="true" />
            </Button>
            <button
              type="button"
              className="w-12 text-center text-sm tabular-nums hover:underline"
              onClick={() => setZoom(1)}
              title="Réinitialiser le zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoomer"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
            >
              <ZoomInIcon aria-hidden="true" />
            </Button>
          </div>
          <VersionsDialog
            documentId={documentId}
            currentVersionId={versionId}
            documentName={currentDocName}
            versions={versionList}
            onRenamed={(vId, newName) => {
              setVersionList((current) =>
                current.map((v) => (v.id === vId ? { ...v, name: newName } : v))
              )
            }}
            onDeleted={(deletedId, remaining) => {
              setVersionList(remaining)
              if (deletedId === versionId) {
                const next = [...remaining].sort(
                  (a, b) => b.versionNumber - a.versionNumber
                )[0]
                if (next) {
                  router.push(`/documents/${documentId}/versions/${next.id}`)
                  router.refresh()
                }
              }
            }}
          />
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
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex flex-col items-center gap-6">
              {structure.pages.map((page) => (
                <PdfPageView
                  key={page.number}
                  pdfDoc={pdfDoc}
                  page={page}
                  zoom={zoom}
                  selection={selection}
                  edits={edits}
                  spanBoxes={spanBoxes}
                  imageEdits={imageEdits}
                  editingId={editingId}
                  croppingId={croppingId}
                  imageSrc={imageSrc}
                  onSelect={setSelection}
                  onStartEdit={(id) => setEditingId(id)}
                  onCommitEdit={commitEdit}
                  onCancelEdit={() => setEditingId(null)}
                  onResizeSpan={resizeSpanBox}
                  onTransformImage={transformImage}
                  onCropImage={cropImage}
                />
              ))}
            </div>
          </div>
          <aside className="sticky top-6 hidden w-72 shrink-0 flex-col gap-4 lg:flex">
            <SelectionPanel
              selected={selected}
              edits={edits}
              spanBoxes={spanBoxes}
              imageEdits={imageEdits}
              cropping={croppingId}
              onRevert={revertSpan}
              onReplaceImage={replaceImage}
              onDeleteImage={deleteImage}
              onRevertImage={revertImageEdit}
              onToggleCrop={(imageId) =>
                setCroppingId((current) => {
                  if (current === imageId) return null
                  ensureTransform(imageId)
                  return imageId
                })
              }
            />
            {editCount > 0 ? (
              <EditsPanel
                edits={edits}
                spanBoxes={spanBoxes}
                imageEdits={imageEdits}
                spanIndex={spanIndex}
                imageIndex={imageIndex}
                onSelect={goToElement}
                onRevert={revertSpan}
                onRevertImage={revertImageEdit}
              />
            ) : null}
          </aside>
        </div>
      )}

      {/* Rename Document Dialog */}
      <Dialog
        open={renameDocOpen}
        onOpenChange={(open) => {
          if (!open && !renamingDoc) setRenameDocOpen(false)
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
              value={renameDocInput}
              onChange={(e) => setRenameDocInput(e.target.value)}
              placeholder="Nom du document"
              required
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renamingDoc}
                onClick={() => setRenameDocOpen(false)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={renamingDoc || !renameDocInput.trim()}>
                {renamingDoc ? <Spinner data-icon="inline-start" /> : null}
                Enregistrer
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PdfPageView({
  pdfDoc,
  page,
  zoom,
  selection,
  edits,
  spanBoxes,
  imageEdits,
  editingId,
  croppingId,
  imageSrc,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onResizeSpan,
  onTransformImage,
  onCropImage,
}: {
  pdfDoc: PDFDocumentProxy | null
  page: PdfPageStructure
  zoom: number
  selection: Selection | null
  edits: Record<string, string>
  spanBoxes: Record<string, SpanBox>
  imageEdits: Record<string, ImageEdit>
  editingId: string | null
  croppingId: string | null
  imageSrc: (xref: number) => string
  onSelect: (selection: Selection) => void
  onStartEdit: (spanId: string) => void
  onCommitEdit: (span: PdfSpan, draft: string) => void
  onCancelEdit: () => void
  onResizeSpan: (span: PdfSpan, bbox: BBox) => void
  onTransformImage: (imageId: string, bbox: BBox) => void
  onCropImage: (imageId: string, crop: Crop) => void
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
      // Render the bitmap at the displayed CSS width (which follows the
      // internal zoom) times the device pixel ratio, so it stays crisp at
      // every zoom level and independent of the browser's own zoom.
      const displayWidth = pxWidth > 0 ? pxWidth : BASE_PAGE_WIDTH * zoom
      const scale = (displayWidth * Math.min(window.devicePixelRatio || 1, 2)) / page.width
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
  }, [pdfDoc, page.number, pxWidth, zoom, page.width])

  // Display scale: CSS px per PDF point, for font sizing in overlays.
  const scale = pxWidth > 0 ? pxWidth / page.width : 0

  function effectiveSpan(span: PdfSpan) {
    const o = spanBoxes[span.id]
    return o ? { bbox: o.bbox, origin: o.origin, size: o.size } : {
      bbox: span.bbox,
      origin: span.origin,
      size: span.size,
    }
  }

  function spanTextStyle(size: number, bbox: BBox, span: PdfSpan): React.CSSProperties {
    return {
      fontSize: size * scale,
      lineHeight: `${(bbox[3] - bbox[1]) * scale}px`,
      fontFamily: spanFontFamily(span),
      fontWeight: span.bold ? 700 : 400,
      fontStyle: span.italic ? "italic" : "normal",
      color: span.color,
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0 overflow-hidden rounded-md border bg-white shadow-sm"
      style={{
        width: BASE_PAGE_WIDTH * zoom,
        maxWidth: "none",
        aspectRatio: `${page.width} / ${page.height}`,
      }}
      data-page={page.number}
    >
      {!rendered ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />

      {page.spans.map((span) => {
        const eff = effectiveSpan(span)
        const edited = span.id in edits
        const effectiveText = edited ? edits[span.id] : span.text
        const isSelected =
          selection?.type === "span" &&
          selection.id === span.id &&
          selection.pageIndex === page.number
        if (editingId === span.id && scale > 0) {
          return (
            <div key={span.id}>
              <SpanEditor
                span={span}
                initialValue={effectiveText}
                style={{
                  ...bboxToPercent(eff.bbox, page.width, page.height),
                  ...spanTextStyle(eff.size, eff.bbox, span),
                }}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
              />
              <GeometryOverlay
                bbox={eff.bbox}
                pageWidth={page.width}
                pageHeight={page.height}
                colorClass="ring-primary"
                allowMove={false}
                onChange={(bbox) => onResizeSpan(span, bbox)}
              />
            </div>
          )
        }
        return (
          <div key={span.id}>
            <button
              type="button"
              title={effectiveText}
              aria-label={`Texte : ${effectiveText}`}
              className={cn(
                "absolute cursor-text rounded-xs text-left whitespace-nowrap",
                edited ? "bg-white" : "bg-transparent text-transparent",
                isSelected
                  ? "ring-2 ring-primary"
                  : edited
                    ? "ring-1 ring-primary/40 hover:ring-2 hover:ring-primary/60"
                    : "hover:bg-primary/5 hover:ring-2 hover:ring-primary/40"
              )}
              style={{
                ...bboxToPercent(eff.bbox, page.width, page.height),
                ...(edited && scale > 0 ? spanTextStyle(eff.size, eff.bbox, span) : {}),
              }}
              onClick={() => {
                onSelect({ pageIndex: page.number, type: "span", id: span.id })
                onStartEdit(span.id)
              }}
            >
              {edited && scale > 0 ? edits[span.id] : null}
            </button>
            {isSelected && scale > 0 ? (
              <GeometryOverlay
                bbox={eff.bbox}
                pageWidth={page.width}
                pageHeight={page.height}
                colorClass="ring-primary"
                allowMove={false}
                onChange={(bbox) => onResizeSpan(span, bbox)}
              />
            ) : null}
          </div>
        )
      })}

      {page.images.map((image) => {
        const edit = imageEdits[image.id]
        const isSelected =
          selection?.type === "image" &&
          selection.id === image.id &&
          selection.pageIndex === page.number
        const transform = edit?.type === "transform" ? edit : null
        const effBbox: BBox = transform ? transform.bbox : image.bbox
        const src = transform?.dataUrl ?? imageSrc(image.xref)
        const cropping = croppingId === image.id && isSelected && transform !== null

        return (
          <div key={image.id}>
            {/* Cover the original placement whenever the image moved/was removed. */}
            {edit ? (
              <div
                aria-hidden="true"
                className="absolute bg-white"
                style={bboxToPercent(image.bbox, page.width, page.height)}
              />
            ) : null}

            <button
              type="button"
              aria-label={
                edit?.type === "delete"
                  ? "Image supprimée"
                  : transform
                    ? "Image modifiée"
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
              style={bboxToPercent(
                edit?.type === "delete" ? image.bbox : effBbox,
                page.width,
                page.height
              )}
              onClick={() =>
                onSelect({ pageIndex: page.number, type: "image", id: image.id })
              }
            >
              {transform && !cropping ? (
                <span
                  className="block size-full"
                  style={cropFillStyle(src, transform.crop)}
                />
              ) : null}
              {transform && cropping ? (
                <span
                  className="block size-full"
                  style={cropFillStyle(src, null)}
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

            {/* Geometry handles when selected (move/resize), unless cropping. */}
            {isSelected && edit?.type !== "delete" && !cropping ? (
              <GeometryOverlay
                bbox={effBbox}
                pageWidth={page.width}
                pageHeight={page.height}
                colorClass="ring-chart-2"
                allowMove
                onChange={(bbox) => onTransformImage(image.id, bbox)}
              />
            ) : null}

            {/* Crop handles when in crop mode. */}
            {cropping && transform ? (
              <CropOverlay
                bbox={effBbox}
                crop={transform.crop ?? { left: 0, top: 0, right: 1, bottom: 1 }}
                pageWidth={page.width}
                pageHeight={page.height}
                onChange={(crop) => onCropImage(image.id, crop)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function GeometryOverlay({
  bbox,
  pageWidth,
  pageHeight,
  colorClass,
  allowMove,
  onChange,
}: {
  bbox: BBox
  pageWidth: number
  pageHeight: number
  colorClass: string
  allowMove: boolean
  onChange: (bbox: BBox) => void
}) {
  const startRef = useRef<BBox>(bbox)

  function startDrag(event: React.PointerEvent, handle: string) {
    startRef.current = bbox
    beginPointerDrag(event, pageWidth, pageHeight, (dx, dy) => {
      const next =
        handle === "move"
          ? moveBbox(startRef.current, dx, dy, pageWidth, pageHeight)
          : resizeBbox(startRef.current, handle, dx, dy, pageWidth, pageHeight)
      onChange(next)
    })
  }

  return (
    <div
      className={cn("pointer-events-none absolute z-20 ring-2", colorClass)}
      style={bboxToPercent(bbox, pageWidth, pageHeight)}
    >
      {allowMove ? (
        <div
          className="pointer-events-auto absolute inset-0 cursor-move"
          onPointerDown={(e) => startDrag(e, "move")}
        />
      ) : null}
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.id}
          className={cn(
            "pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary shadow",
            colorClass.includes("chart-2") && "bg-chart-2"
          )}
          style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, cursor: h.cursor }}
          onPointerDown={(e) => startDrag(e, h.id)}
        />
      ))}
    </div>
  )
}

function CropOverlay({
  bbox,
  crop,
  pageWidth,
  pageHeight,
  onChange,
}: {
  bbox: BBox
  crop: Crop
  pageWidth: number
  pageHeight: number
  onChange: (crop: Crop) => void
}) {
  const startRef = useRef<Crop>(crop)
  const boxW = bbox[2] - bbox[0]
  const boxH = bbox[3] - bbox[1]

  function startDrag(event: React.PointerEvent, handle: string) {
    startRef.current = crop
    beginPointerDrag(event, pageWidth, pageHeight, (dx, dy) => {
      onChange(resizeCrop(startRef.current, handle, dx / boxW, dy / boxH))
    })
  }

  return (
    <div
      className="pointer-events-none absolute z-30 overflow-hidden"
      style={bboxToPercent(bbox, pageWidth, pageHeight)}
    >
      {/* The kept region; box-shadow dims everything outside it. */}
      <div
        className="absolute ring-2 ring-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
        style={{
          left: `${crop.left * 100}%`,
          top: `${crop.top * 100}%`,
          width: `${(crop.right - crop.left) * 100}%`,
          height: `${(crop.bottom - crop.top) * 100}%`,
        }}
      >
        {RESIZE_HANDLES.map((h) => (
          <div
            key={h.id}
            className="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-chart-2 bg-white shadow"
            style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, cursor: h.cursor }}
            onPointerDown={(e) => startDrag(e, h.id)}
          />
        ))}
      </div>
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
  spanBoxes,
  imageEdits,
  cropping,
  onRevert,
  onReplaceImage,
  onDeleteImage,
  onRevertImage,
  onToggleCrop,
}: {
  selected: { type: "span"; span: PdfSpan } | { type: "image"; image: PdfImage } | null
  edits: Record<string, string>
  spanBoxes: Record<string, SpanBox>
  imageEdits: Record<string, ImageEdit>
  cropping: string | null
  onRevert: (spanId: string) => void
  onReplaceImage: (imageId: string, file: File) => void
  onDeleteImage: (imageId: string) => void
  onRevertImage: (imageId: string) => void
  onToggleCrop: (imageId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageEdit = selected?.type === "image" ? imageEdits[selected.image.id] : undefined
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sélection</CardTitle>
        <CardDescription>
          {selected
            ? "Style détecté de l'élément sélectionné"
            : "Cliquez sur un texte ou une image"}
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
                <dd>
                  {Math.round(
                    (spanBoxes[selected.span.id]?.size ?? selected.span.size) * 10
                  ) / 10}{" "}
                  pt
                </dd>
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
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MoveIcon className="size-3.5" aria-hidden="true" />
                Faites glisser les poignées pour redimensionner la zone.
              </p>
              {selected.span.id in edits || selected.span.id in spanBoxes ? (
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
                {imageEdit ? (
                  <Badge variant="secondary">
                    {imageEdit.type === "delete" ? "Supprimée" : "Modifiée"}
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
                <Button
                  variant={cropping === selected.image.id ? "default" : "outline"}
                  size="sm"
                  disabled={imageEdit?.type === "delete"}
                  onClick={() => onToggleCrop(selected.image.id)}
                >
                  <CropIcon data-icon="inline-start" aria-hidden="true" />
                  {cropping === selected.image.id ? "Terminer le recadrage" : "Recadrer…"}
                </Button>
                {imageEdit ? (
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
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MoveIcon className="size-3.5" aria-hidden="true" />
                Faites glisser l&apos;image pour la déplacer, les poignées pour la
                redimensionner.
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
  spanBoxes,
  imageEdits,
  spanIndex,
  imageIndex,
  onSelect,
  onRevert,
  onRevertImage,
}: {
  edits: Record<string, string>
  spanBoxes: Record<string, SpanBox>
  imageEdits: Record<string, ImageEdit>
  spanIndex: Map<string, { page: PdfPageStructure; span: PdfSpan }>
  imageIndex: Map<string, { page: PdfPageStructure; image: PdfImage }>
  onSelect: (selection: Selection) => void
  onRevert: (spanId: string) => void
  onRevertImage: (imageId: string) => void
}) {
  const spanIds = new Set([...Object.keys(edits), ...Object.keys(spanBoxes)])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifications</CardTitle>
        <CardDescription>Cliquez une ligne pour la retrouver dans le PDF</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {[...spanIds].map((spanId) => {
          const entry = spanIndex.get(spanId)
          if (!entry) return null
          const newText = spanId in edits ? edits[spanId] : entry.span.text
          const resized = spanId in spanBoxes
          return (
            <div
              key={spanId}
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                onClick={() =>
                  onSelect({ pageIndex: entry.page.number, type: "span", id: spanId })
                }
              >
                <span className="truncate text-muted-foreground line-through">
                  {entry.span.text}
                </span>
                <span className="truncate">
                  {newText || <em className="text-muted-foreground">(supprimé)</em>}
                  {resized ? (
                    <Badge variant="secondary" className="ml-1.5 align-middle">
                      redimensionné
                    </Badge>
                  ) : null}
                </span>
              </button>
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
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() =>
                  onSelect({ pageIndex: entry.page.number, type: "image", id: imageId })
                }
              >
                {edit.type === "transform" && edit.dataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={edit.dataUrl}
                    alt=""
                    className="size-8 shrink-0 rounded-xs border object-cover"
                  />
                ) : edit.type === "delete" ? (
                  <ImageOffIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <ImageIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">
                  Image p.{entry.page.number + 1} ·{" "}
                  {edit.type === "delete" ? "supprimée" : "modifiée"}
                </span>
              </button>
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

function VersionsDialog({
  documentId,
  currentVersionId,
  documentName,
  versions,
  onRenamed,
  onDeleted,
}: {
  documentId: string
  currentVersionId: string
  documentName: string
  versions: VersionSummary[]
  onRenamed: (versionId: string, newName: string | null) => void
  onDeleted: (deletedId: string, remaining: VersionSummary[]) => void
}) {
  const [deleteTarget, setDeleteTarget] = useState<VersionSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [renameTarget, setRenameTarget] = useState<VersionSummary | null>(null)
  const [renameInput, setRenameInput] = useState("")
  const [renaming, setRenaming] = useState(false)

  async function handleRenameVersion() {
    if (!renameTarget) return
    setRenaming(true)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/versions/${renameTarget.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: renameInput.trim() }),
        }
      )
      if (!response.ok) {
        toast.add({ type: "error", title: "Renommage de version impossible" })
        return
      }
      toast.add({ type: "success", title: "Version renommée" })
      const newName = renameInput.trim() || null
      onRenamed(renameTarget.id, newName)
      setRenameTarget(null)
    } finally {
      setRenaming(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/versions/${deleteTarget.id}`,
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
      onDeleted(
        deleteTarget.id,
        versions.filter((v) => v.id !== deleteTarget.id)
      )
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Dialog>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <HistoryIcon data-icon="inline-start" aria-hidden="true" />
          Versions
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Versions de « {documentName} »</DialogTitle>
            <DialogDescription>
              Ouvrez une autre version sans quitter l&apos;éditeur.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {versions.map((version) => {
              const isCurrent = version.id === currentVersionId
              return (
                <div
                  key={version.id}
                  className={cn(
                    "flex items-center justify-between gap-4 rounded-md border p-3",
                    isCurrent && "border-primary bg-primary/5"
                  )}
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
                      {isCurrent ? <Badge variant="secondary">Actuelle</Badge> : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
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
                        setRenameTarget(version)
                        setRenameInput(version.name || "")
                      }}
                    >
                      <TagIcon aria-hidden="true" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isCurrent}
                      nativeButton={false}
                      render={
                        <Link
                          href={`/documents/${documentId}/versions/${version.id}`}
                        />
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
                        <a
                          href={`/api/documents/${documentId}/versions/${version.id}/download`}
                          download
                        />
                      }
                    >
                      <DownloadIcon data-icon="inline-start" aria-hidden="true" />
                      Télécharger
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Supprimer la version"
                      disabled={versions.length <= 1}
                      onClick={() => setDeleteTarget(version)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </DialogContent>

        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open && !deleting) setDeleteTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Supprimer{" "}
                {deleteTarget?.versionNumber === 0
                  ? "l'original"
                  : `la version ${deleteTarget?.versionNumber}`}{" "}
                ?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.id === currentVersionId
                  ? "C'est la version actuellement ouverte : l'éditeur basculera sur la version la plus récente restante."
                  : "Cette version sera définitivement supprimée."}
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
      </Dialog>

      {/* Rename Version Dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenameTarget(null)
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
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder={
                renameTarget?.versionNumber === 0
                  ? "Original"
                  : `Version ${renameTarget?.versionNumber}`
              }
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => setRenameTarget(null)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? <Spinner data-icon="inline-start" /> : null}
                Enregistrer
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Programmatically triggers a browser download of a same-origin URL. */
function triggerDownload(url: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = ""
  document.body.appendChild(a)
  a.click()
  a.remove()
}
