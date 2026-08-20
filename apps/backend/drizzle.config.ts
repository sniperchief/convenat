import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation only.
 *
 * `drizzle-kit generate` diffs the schema against the existing migrations and
 * writes SQL; it needs no database connection, so migrations can be produced
 * offline. `DATABASE_URL` is read only by commands that actually connect.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/covenant',
  },
});
