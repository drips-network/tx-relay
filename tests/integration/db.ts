import postgres from "postgres";

// Matches docker-compose.dev.yml's `db` service and the app's own default `DB_URL`.
const sql = postgres("postgres://user:password@localhost:5432/tx_relay");

export async function resetDb() {
  // Drizzle's own migration-tracking table lives in a separate "drizzle" schema, so this
  // naturally truncates only the app's own tables without needing to name them individually.
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  if (tables.length === 0) return;
  const identifiers = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${identifiers} RESTART IDENTITY CASCADE`);
}
