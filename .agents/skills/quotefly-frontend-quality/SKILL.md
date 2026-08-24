---
name: quotefly-frontend-quality
description: Design, diagnose, review, and improve QuoteFly's React workspace for robust mobile and desktop use. Use for Goldface work involving responsive layouts, field usability, accessibility, shared UI primitives, loading and error states, API interactions, route behavior, frontend performance, or end-to-end customer-to-quote workflows.
---

# QuoteFly Frontend Quality

Optimize the real contractor workspace for fast field use.

## Inspect the workflow

1. Read `AGENTS.md`, the affected route in `web/src/App.tsx`, shared components, `web/src/lib/api.ts`, and relevant Playwright coverage.
2. Trace the complete user action through loading, success, empty, validation, permission, billing, offline/network, and provider-error states.
3. Inspect both a narrow mobile viewport and a desktop viewport. Include keyboard use, focus order, labels, contrast, overflow, long content, and reduced interaction space.

## Implement safely

- Reuse `web/src/components/ui` and lucide icons before introducing new primitives.
- Keep primary mobile tap targets at least 44px and avoid hover-only actions.
- Prefer compact, readable workspace layouts over decorative marketing patterns.
- Keep API access centralized in `web/src/lib/api.ts` with `credentials: "include"`.
- Keep tokens out of browser storage and internal/provider errors out of customer copy.
- Stabilize effects and callbacks instead of suppressing hook warnings.
- Preserve unsaved edits, mutation feedback, retry behavior, and disabled/loading states.
- Split oversized components only when the extraction creates a clear boundary and preserves behavior.

Do not redesign unrelated surfaces during a scoped fix. Do not expose internal costs, margin, secrets, or tenant-internal data in share/PDF/customer paths.

## Verify

Run `npm run build:web` and `npm run lint:web`. Add or update Playwright coverage for changed critical behavior and run the relevant desktop and mobile projects. For the launch path, smoke customer lookup/create, quote creation/editing, PDF preview/download, send/share, follow-up, billing, and touched integrations. Record real-device checks separately from emulated viewport checks.

Return viewport evidence, accessibility and state coverage, commands run, unresolved device/provider checks, and the files changed. Send the result to Opera.
