// Shared types for the structure extracted by the pdf-service.
// Bboxes are [x0, y0, x1, y1] in PDF points, origin top-left, y downward.

export type BBox = [number, number, number, number]

export interface PdfSpan {
  id: string
  text: string
  bbox: BBox
  font: string
  size: number
  color: string
  bold: boolean
  italic: boolean
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
