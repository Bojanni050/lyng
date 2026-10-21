## 2026-10-21 (CI and fork safety)

- Findings: CI only ran on `master`, while the active branch is `main`; fork-specific safeguards could be silently reverted; postinstall still fetched an upstream mailsync binary whose path gate prevents Nuntio from starting.
- Conclusions: Run CI on both branch names and cancel superseded runs; enforce the fork-specific assumptions with a fast, dependency-free failing check; never fetch the upstream engine as a fallback, and point contributors to the fork release or local submodule build instead.
- Actions: Updated `.github/workflows/test.yaml`, `package.json`, `scripts/check-fork-invariants.js`, `scripts/postinstall.js`, `scripts/fetch-mailsync.js`, and `NUNTIO.md`; added this walkthrough entry. The invariant check passes all 14 checks, a simulated broken updater invariant exits non-zero, JavaScript syntax and workflow YAML parse checks pass, and the direct TypeScript compiler check passes. `npm run lint:check` still reports pre-existing formatting issues in untouched files; validated.

## 2026-10-21 (Tracking sync account matching)

- Findings: The tracking server returns `accountId`, but `tracking-sync` selected the first non-draft local message with a matching header message ID. Duplicate IDs across accounts could therefore apply open/click metadata to the wrong message; the poller's `finally` recovery after server errors also lacked regression coverage.
- Conclusions: Match both header message ID and server-reported account ID when that ID is present. Keep the prior first-non-draft fallback for entries whose account ID is null/absent, as click-only entries may not identify an account. Cover both account disambiguation and retry after an HTTP failure through the real `pollOnce()` flow.
- Actions: Updated `app/internal_packages/tracking-sync/lib/main.ts` and added `app/internal_packages/tracking-sync/specs/main-spec.ts`; the account-collision test was confirmed failing before the fix, and both focused specs pass afterward, including 503 then successful retry; validated.
