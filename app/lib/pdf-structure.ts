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

export type EditOperation =
  | TextEditOperation
  | DeleteImageOperation
  | ReplaceImageOperation

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

export function buildTextEditOperation(
  pageNumber: number,
  span: PdfSpan,
  newText: string
): TextEditOperation {
  return {
    type: "edit_text",
    pageNumber,
    spanId: span.id,
    bbox: span.bbox,
    origin: span.origin,
    newText,
    font: span.font,
    size: span.size,
    color: span.color,
    bold: span.bold,
    italic: span.italic,
  }
}

export interface PdfImage {
  id: string
  xref: number
  bbox: BBox
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
}
