import { sql } from "drizzle-orm"

import { db } from "@/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await db.execute(sql`select 1`)
    return Response.json({ status: "ok" })
  } catch {
    return Response.json({ status: "error", detail: "database unreachable" }, { status: 503 })
  }
}
