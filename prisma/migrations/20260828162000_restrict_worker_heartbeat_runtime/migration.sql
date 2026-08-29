-- Heartbeats are append/update operational evidence. Neither the API nor the
-- worker needs to delete them.
REVOKE DELETE ON TABLE "WorkerHeartbeat" FROM quotefly_runtime;
