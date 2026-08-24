/**
 * Database schema auto-heal.
 *
 * Applies the idempotent, additive pending migrations (the exact same SQL the
 * admin "Sync database schema" button runs) at most once per process. The DB
 * query layer calls this automatically when a query fails because a column/table
 * is missing, so the app recovers on its own when it points at an un-migrated
 * database — instead of showing "column ... does not exist" until someone clicks
 * a button. This is disabled by default and must be explicitly enabled with
 * AUTO_SCHEMA_SYNC=1; production web runtimes should not have DDL privileges.
 */
let synced = false;
let inFlight: Promise<void> | null = null;

/** True while a heal is running — used to avoid re-entrancy from the DDL itself. */
export function isSchemaSyncing(): boolean {
  return inFlight !== null;
}

export async function ensureSchemaApplied(): Promise<void> {
  if (synced) return;
  if (process.env.AUTO_SCHEMA_SYNC !== "1") return;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const { applyPendingSchema } = await import("./schema-sync.server");
        const result = await applyPendingSchema();
        const failed = result.reports.filter((r) => r.errors.length > 0);
        if (failed.length === 0) {
          synced = true;
          console.log("[AutoSchema] Database schema ensured (auto-applied pending migrations).");
        } else {
          console.error("[AutoSchema] Some statements failed:", failed.map((r) => r.migration).join(", "));
        }
      } catch (err: any) {
        console.error("[AutoSchema] Failed to ensure schema:", err?.message);
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}
