// Shared types for the structure extracted by the pdf-service.
// Bboxes are [x0, y0, x1, y1] in PDF points, origin top-left, y downward.

export type BBox = [number, number, number, number]

export interface PdfSpan {
  id: string
  text: string
  bbox: BBox
  /** Baseline start point [x, y] — where text is reinserted on export. */
  origin: [number, number]
  font: string
  size: number
  color: string
  bold: boolean
  italic: boolean
  /** xref of the embedded font to preview via @font-face, or null. */
  fontFile: number | null
}

/** An embedded font offered to the editor preview as @font-face. */
export interface PdfFont {
  xref: number
  format: "truetype" | "opentype"
  /** Weight/slant the program itself carries, declared on the @font-face so
   * the browser doesn't synthesize bold/italic on top of it. */
  bold: boolean
  italic: boolean
}

/** Sub-region of a source image kept on export, as fractions in 0..1. */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

/** Entries of the edit journal replayed by the pdf-service on export. */
export interface TextEditOperation {
  type: "edit_text"
  pageNumber: number
  spanId: string
  bbox: BBox
  origin: [number, number]
  newText: string
  font: string
  size: number
  color: string
  bold: boolean
  italic: boolean
  /** True when the box was manually resized (bounds shrink-to-fit strictly). */
  boxResized?: boolean
}

export interface DeleteImageOperation {
  type: "delete_image"
  pageNumber: number
  imageId: string
  xref: number
}

export interface ReplaceImageOperation {
  type: "replace_image"
  pageNumber: number
  imageId: string
  xref: number
  /** PNG or JPEG bytes; stretched into the original placement rect on export. */
  imageBase64: string
}

export interface PlaceImageOperation {
  type: "place_image"
  pageNumber: number
  imageId: string
  xref: number
  /** New placement rect in PDF points, top-left origin. */
  rect: BBox
  /** Source sub-region kept, fractions [left, top, right, bottom]. */
  crop: [number, number, number, number] | null
  /** Replacement PNG/JPEG base64; null reuses the original image. */
  imageBase64: string | null
}

export type EditOperation =
  | TextEditOperation
  | DeleteImageOperation
  | ReplaceImageOperation
  | PlaceImageOperation

export function buildDeleteImageOperation(
  pageNumber: number,
  image: PdfImage
): DeleteImageOperation {
  return { type: "delete_image", pageNumber, imageId: image.id, xref: image.xref }
}

export function buildReplaceImageOperation(
  pageNumber: number,
  image: PdfImage,
  imageBase64: string
): ReplaceImageOperation {
  return {
    type: "replace_image",
    pageNumber,
    imageId: image.id,
    xref: image.xref,
    imageBase64,
  }
}

/** Optional geometry override when the span box was manually resized. */
export interface SpanBox {
  bbox: BBox
  origin: [number, number]
  size: number
}

export function buildTextEditOperation(
  pageNumber: number,
  span: PdfSpan,
  newText: string,
  box?: SpanBox
): TextEditOperation {
  return {
    type: "edit_text",
    pageNumber,
    spanId: span.id,
    bbox: box?.bbox ?? span.bbox,
    origin: box?.origin ?? span.origin,
    newText,
    font: span.font,
    size: box?.size ?? span.size,
    color: span.color,
    bold: span.bold,
    italic: span.italic,
    boxResized: box !== undefined,
  }
}

export function buildPlaceImageOperation(
  pageNumber: number,
  image: PdfImage,
  rect: BBox,
  crop: Crop | null,
  imageBase64: string | null
): PlaceImageOperation {
  return {
    type: "place_image",
    pageNumber,
    imageId: image.id,
    xref: image.xref,
    rect,
    crop: crop
      ? [crop.left, crop.top, crop.right, crop.bottom]
      : null,
    imageBase64,
  }
}

export interface PdfImage {
  id: string
  xref: number
  bbox: BBox
  /** Near-full-page flattened background: rendered but not interactive. */
  background?: boolean
}

export interface PdfPageStructure {
  number: number
  width: number
  height: number
  spans: PdfSpan[]
  images: PdfImage[]
}

export interface PdfStructure {
  pageCount: number
  pages: PdfPageStructure[]
  fonts: PdfFont[]
}
