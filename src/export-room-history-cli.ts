#!/usr/bin/env node
// ── Matrix Room Exporter CLI ──────────────────────────────────────────────
//
// Thin shim: delegates to `main` from `./export-room-history.ts`.
// Wired as the `matrix-export-room-history` bin in package.json.

import { main } from './export-room-history.ts';

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
