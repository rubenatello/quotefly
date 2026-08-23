-- Supports bounded tenant-scoped soft-archive scans for read and never-read
-- in-app notifications. Runtime DELETE/TRUNCATE restrictions remain unchanged.
CREATE INDEX "NotificationOutbox_retention_idx"
    ON "NotificationOutbox"("tenantId", "archivedAtUtc", "readAtUtc", "createdAt", "id");
