# Desktop Shortcut and Phone Display

## Background and goal

The dashboard gained an optional iPhone external-display mode while retaining a local-only desktop HUD. The goal was to make the desktop shortcut launch both the normal dashboard and the paired phone display reliably, then resolve two shortcut failures reported during validation.

## Design and trade-offs

- The desktop shortcut continues to launch the complete mode so a normal double-click brings up the HUD and the optional phone endpoint together.
- The desktop Electron process owns the primary loopback dashboard service on port 8787 and a companion phone-display service on port 8788. Closing the window hides it to the tray; choosing the tray's explicit Exit command stops both services.
- Launchers prefer a current unpacked release build, then the portable build, then development Electron. This keeps ordinary shortcut use independent from the development shell, but requires rebuilding `release/` after source changes. `release/` remains ignored generated output.

## Work completed

- Added the phone-display server, pairing flow, read-only phone UI, configuration synchronization, tray status, and associated tests and documentation.
- Updated the desktop shortcut manager and launchers to start and verify complete phone mode.
- Fixed `run-dashboard-complete.vbs`: Windows Script Host parsed a UTF-8 Chinese string as ANSI and raised VBScript error `800A0401` on line 13. The VBS source now uses an ASCII-safe error string, with a regression test that requires all runner content to be ASCII.
- Investigated the subsequent startup-check dialog. The shortcut was starting stale/incomplete `release` artifacts: the unpacked build lacked `icudtl.dat`, and its packaged `desktop/main.js` predated the companion phone-service implementation. The app either exited before startup or left port 8788 unavailable.
- Regenerated the Windows portable release from the current source. The regenerated `release/win-unpacked` contains `icudtl.dat` and the packaged desktop main process includes `ensurePhoneDisplayServer`.

## Files changed

- Desktop/runtime: `desktop/main.js`, `desktop/menu-template.js`, `desktop/window-bounds.js`, `server.js`, `lib/http.js`, `lib/dashboard-config.js`, `lib/phone-display.js`.
- Phone client and launcher: `phone-display.*`, `phone-pair.css`, `start-dashboard-phone.bat`, `start-dashboard-complete.ps1`, `run-dashboard-complete.vbs`, and shortcut scripts.
- Documentation and safety: `README.md`, `docs/PHONE_DISPLAY.md`, `SECURITY.md`, `.gitignore`, `package.json`.
- Regression coverage: `test/phone-display.test.js`, `test/windows-scripts.test.js`, plus desktop/server/config tests.

## Verification

- `npm run check` completed with exit code 0: 102 tests passed.
- `npm run pack:win` regenerated the ignored Windows release artifacts.
- `cscript.exe //nologo run-dashboard-complete.vbs` completed with `ShortcutRunnerExitCode=0`.
- `GET http://127.0.0.1:8787/healthz` returned HTTP 200 with `x-usage-dashboard: 1`.
- `GET http://127.0.0.1:8788/phone/` returned HTTP 200 with `x-usage-phone-display: 1`.

## Current status

The desktop shortcut, desktop dashboard service, and phone-display service are working. The generated `release/` output is intentionally ignored; current source and tests are ready to commit.

## Next steps

- Commit and push the source, tests, documentation, and this archive record.
- After future desktop or phone-launcher source changes, run `npm run pack:win` before testing the desktop shortcut so it does not pick an old release artifact.
