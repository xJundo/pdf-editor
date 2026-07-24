"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { ArrowLeftIcon, ImageIcon, TypeIcon } from "lucide-react"

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
import { cn } from "@/lib/utils"
import type { PdfImage, PdfPageStructure, PdfSpan, PdfStructure } from "@/lib/pdf-structure"

interface Selection {
  pageIndex: number
  type: "span" | "image"
  id: string
}

export function PdfEditor({
  fileUrl,
  structure,
  documentName,
  versionNumber,
}: {
  fileUrl: string
  structure: PdfStructure
  documentName: string
  versionNumber: number
}) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)

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
                onSelect={setSelection}
              />
            ))}
          </div>
          <aside className="sticky top-6 hidden w-72 shrink-0 lg:block">
            <SelectionPanel selected={selected} />
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
  onSelect,
}: {
  pdfDoc: PDFDocumentProxy | null
  page: PdfPageStructure
  selection: Selection | null
  onSelect: (selection: Selection) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)

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

  function toPercent(bbox: [number, number, number, number]) {
    return {
      left: `${(bbox[0] / page.width) * 100}%`,
      top: `${(bbox[1] / page.height) * 100}%`,
      width: `${((bbox[2] - bbox[0]) / page.width) * 100}%`,
      height: `${((bbox[3] - bbox[1]) / page.height) * 100}%`,
    }
  }

  return (
    <div
      className="relative w-full max-w-3xl overflow-hidden rounded-md border bg-white shadow-sm"
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      data-page={page.number}
    >
      {!rendered ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {page.spans.map((span) => (
        <button
          key={span.id}
          type="button"
          title={span.text}
          aria-label={`Texte : ${span.text}`}
          className={cn(
            "absolute cursor-pointer rounded-xs",
            selection?.type === "span" && selection.id === span.id && selection.pageIndex === page.number
              ? "bg-primary/10 ring-2 ring-primary"
              : "hover:bg-primary/5 hover:ring-2 hover:ring-primary/40"
          )}
          style={toPercent(span.bbox)}
          onClick={() => onSelect({ pageIndex: page.number, type: "span", id: span.id })}
        />
      ))}
      {page.images.map((image) => (
        <button
          key={image.id}
          type="button"
          aria-label="Image"
          className={cn(
            "absolute cursor-pointer rounded-xs",
            selection?.type === "image" &&
              selection.id === image.id &&
              selection.pageIndex === page.number
              ? "bg-chart-2/15 ring-2 ring-chart-2"
              : "hover:bg-chart-2/10 hover:ring-2 hover:ring-chart-2/50"
          )}
          style={toPercent(image.bbox)}
          onClick={() => onSelect({ pageIndex: page.number, type: "image", id: image.id })}
        />
      ))}
    </div>
  )
}

function displayFontName(font: string) {
  // Embedded subset fonts are prefixed like "ABCDEF+Helvetica".
  const plus = font.indexOf("+")
  return plus === 6 ? font.slice(7) : font
}

function SelectionPanel({
  selected,
}: {
  selected: { type: "span"; span: PdfSpan } | { type: "image"; image: PdfImage } | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sélection</CardTitle>
        <CardDescription>
          {selected
            ? "Style détecté de l'élément sélectionné"
            : "Cliquez sur un texte ou une image du document"}
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
                {selected.span.text}
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
                  {selected.span.italic ? <Badge variant="secondary">Italique</Badge> : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium">
                <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                Image
              </p>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Largeur</dt>
                <dd>{Math.round(selected.image.bbox[2] - selected.image.bbox[0])} pt</dd>
                <dt className="text-muted-foreground">Hauteur</dt>
                <dd>{Math.round(selected.image.bbox[3] - selected.image.bbox[1])} pt</dd>
              </dl>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            L&apos;édition arrive à l&apos;étape suivante.
          </p>
        </CardContent>
      ) : null}
    </Card>
  )
}
