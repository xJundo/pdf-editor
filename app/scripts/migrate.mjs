// Applies SQL migrations from ./drizzle at container startup, before the
// server starts. Uses drizzle-orm's programmatic migrator (drizzle-kit is a
// dev dependency and is not shipped in the production image).
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const maxAttempts = 30
for (let attempt = 1; ; attempt++) {
  try {
    await pool.query("select 1")
    break
  } catch (error) {
    if (attempt === maxAttempts) {
      console.error("Database unreachable after", maxAttempts, "attempts:", error.message)
      process.exit(1)
    }
    console.log(`Waiting for database (${attempt}/${maxAttempts})...`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

await migrate(drizzle(pool), { migrationsFolder: "./drizzle" })
await pool.end()
console.log("Migrations applied.")
