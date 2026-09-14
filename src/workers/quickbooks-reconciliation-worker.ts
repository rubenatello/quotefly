import { startQuickBooksReconciliationWorker } from "./quickbooks-reconciliation-bootstrap";

startQuickBooksReconciliationWorker().catch(() => {
  process.stderr.write('{"event":"quickbooks_reconciliation_worker_bootstrap_failed"}\n');
  process.exitCode = 1;
});
