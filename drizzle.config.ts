import { defineConfig } from "drizzle-kit";
import { getDbUrl } from "./src/config.ts";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: getDbUrl() },
});
