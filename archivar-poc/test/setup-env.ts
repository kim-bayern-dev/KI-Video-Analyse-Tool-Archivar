/**
 * Vitest setup file: loads the project's env file (.env.local, or ENV_FILE)
 * into process.env BEFORE any test module is imported, so tests that import
 * server modules directly resolve the same endpoints and data-dir paths as
 * the running server (module-load-time env reads, e.g. src/db/db.ts).
 */
import { load, getEnv } from "defuss-env";

load(getEnv("ENV_FILE", ".env.local"));
