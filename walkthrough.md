## 2026-10-21 (CI and fork safety)

- Findings: CI only ran on `master`, while the active branch is `main`; fork-specific safeguards could be silently reverted; postinstall still fetched an upstream mailsync binary whose path gate prevents Nuntio from starting.
- Conclusions: Run CI on both branch names and cancel superseded runs; enforce the fork-specific assumptions with a fast, dependency-free failing check; never fetch the upstream engine as a fallback, and point contributors to the fork release or local submodule build instead.
- Actions: Updated `.github/workflows/test.yaml`, `package.json`, `scripts/check-fork-invariants.js`, `scripts/postinstall.js`, `scripts/fetch-mailsync.js`, and `NUNTIO.md`; added this walkthrough entry. The invariant check passes all 14 checks, a simulated broken updater invariant exits non-zero, JavaScript syntax and workflow YAML parse checks pass, and the direct TypeScript compiler check passes. `npm run lint:check` still reports pre-existing formatting issues in untouched files; validated.

## 2026-10-21 (Tracking sync account matching)

- Findings: The tracking server returns `accountId`, but `tracking-sync` selected the first non-draft local message with a matching header message ID. Duplicate IDs across accounts could therefore apply open/click metadata to the wrong message; the poller's `finally` recovery after server errors also lacked regression coverage.
- Conclusions: Match both header message ID and server-reported account ID when that ID is present. Keep the prior first-non-draft fallback for entries whose account ID is null/absent, as click-only entries may not identify an account. Cover both account disambiguation and retry after an HTTP failure through the real `pollOnce()` flow.
- Actions: Updated `app/internal_packages/tracking-sync/lib/main.ts` and added `app/internal_packages/tracking-sync/specs/main-spec.ts`; the account-collision test was confirmed failing before the fix, and both focused specs pass afterward, including 503 then successful retry; validated.

## 2026-10-21 (CI formatting cleanup)

- Findings: GitHub Actions stopped at `lint:check` with 16 remaining Prettier errors in seven files, so CI did not reach the test suite.
- Conclusions: Apply formatting-only changes to exactly the files and lines reported by CI; avoid unrelated refactors or behavior changes.
- Actions: Formatted `app/internal_packages/preferences/lib/tabs/preferences-identity.tsx`, `app/internal_packages/views/lib/agent/quota.ts`, `app/internal_packages/views/lib/sharing/install.ts`, `app/src/config-schema.ts`, `app/src/default-client-helper.ts`, `app/src/flux/stores/account-store.ts`, and `app/src/theme-manager.ts`; `npm run lint:check`, direct TypeScript compilation, and `git diff --check` pass; validated.

## 2026-10-21 (Headless spec runs fail instead of hanging)

- Findings: CI reached the test suite for the first time and timed out after 20 minutes. The log showed "Running database migrations" and then silence. Reproduced locally by renaming `app/mailsync.exe`: the process printed the same line and hung until killed. Cause: `Application.start()` awaits `mailsync.migrate()` before it ever looks at spec mode, and the failure path calls `dialog.showMessageBoxSync`, which blocks forever under xvfb because nothing can dismiss the dialog. The theme error handler in the same file already documents this exact hazard and skips the dialog in spec mode.
- Conclusions: A headless spec run must never open a blocking dialog. Exiting with the error keeps the failure visible in the log and turns a 20 minute timeout into a few seconds, without changing what interactive users see. The CI job still cannot run the suite at all, because the database schema is created by the engine and this fork has no linux-x64 engine artifact; that needs a separate decision about engine provisioning.
- Actions: `app/src/browser/application.ts` logs the migration error and calls `app.exit(1)` when `specMode` is set, before constructing the dialog. Verified by renaming the engine binary: the run went from hanging to `Nuntio could not run the mailsync migration: ... ENOENT` with exit code 1 in seconds; with the engine restored, the tracking-sync specs still pass (2 tests, 0 failures). Prettier, ESLint, and `tsc --noEmit` pass; validated.

## 2026-10-21 (Tests run on Windows in CI)

- Findings: after the spec-run hang was fixed, CI still could not run the suite, because the mail database schema comes from `mailsync migrate` and the fork publishes only `mailsync-win-ia32.tar.gz`. The Linux job had no engine and no way to get one; building the C++ engine on a bare runner needs libetpan against `/opt/openssl`, which is not available there.
- Conclusions: Nuntio targets Windows, so the suite belongs on a Windows runner, where `npm run fetch-mailsync` can pull the published engine artifact. Keeping lint, typecheck, and the fork invariants on Ubuntu keeps that feedback fast and cheap, and the Electron/Xvfb sandbox workarounds disappear with the move.
- Actions: `.github/workflows/test.yaml` split into a `checks` job (Ubuntu: fork invariants, install, lint, typecheck) and a `tests` job (windows-latest: install, `npm run fetch-mailsync`, `npm test` with a 25 minute cap). Removed the Xvfb, dbus, and AppArmor steps from the test path. Workflow YAML parses and passes Prettier; validated by the next CI run.
