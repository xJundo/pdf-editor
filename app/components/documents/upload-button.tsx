"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { UploadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

export function UploadButton() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)

  async function handleFile(file: File) {
    setPending(true)
    try {
      const body = new FormData()
      body.append("file", file)
      const response = await fetch("/api/documents", { method: "POST", body })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        toast.add({
          type: "error",
          title: "Import impossible",
          description: data?.error ?? "Une erreur est survenue.",
        })
        return
      }
      const data = await response.json()
      toast.add({ type: "success", title: `« ${data.name} » importé` })
      router.refresh()
    } finally {
      setPending(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />
      <Button onClick={() => inputRef.current?.click()} disabled={pending}>
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <UploadIcon data-icon="inline-start" aria-hidden="true" />
        )}
        Importer un PDF
      </Button>
    </>
  )
}
