import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"

export async function getSession() {
  return auth.api.getSession({ headers: await headers() })
}

/** Returns the session or redirects to /login. Use in protected pages and layouts. */
export async function requireSession() {
  const session = await getSession()
  if (!session) {
    redirect("/login")
  }
  return session
}
