import { redirect } from "next/navigation"

import { getSession } from "@/lib/session"

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (session) {
    redirect("/documents")
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
