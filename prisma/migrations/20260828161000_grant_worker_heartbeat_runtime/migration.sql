-- The API and reconciliation worker share the constrained runtime role. Allow
-- both processes to publish and inspect operational liveness without granting
-- destructive access to the platform-scoped heartbeat table.
GRANT SELECT, INSERT, UPDATE ON TABLE "WorkerHeartbeat" TO quotefly_runtime;
