import Link from "next/link"
import { FileTextIcon } from "lucide-react"

import { UserMenu } from "@/components/user-menu"
import { requireSession } from "@/lib/session"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
          <nav className="flex items-center gap-6">
            <Link href="/documents" className="flex items-center gap-2 font-medium">
              <FileTextIcon className="size-5" aria-hidden="true" />
              PDF Editor
            </Link>
            <Link
              href="/documents"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Mes documents
            </Link>
          </nav>
          <UserMenu name={session.user.name} email={session.user.email} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  )
}
