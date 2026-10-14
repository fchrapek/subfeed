// Imported first by server/index.ts, so a local .env is in place before any
// module reads process.env at load time (server/db.ts reads SUBFEED_DB).
// In Docker the variables come from compose and there is no .env file.
try {
  process.loadEnvFile()
} catch {
  // no .env: fine
}
