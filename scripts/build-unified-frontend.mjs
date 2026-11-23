#!/usr/bin/env node
/**
 * Compatibility shim — kept so existing `build:frontend` commands still work.
 *
 * The canonical frontend build now lives in `scripts/build-frontend.mjs`.
 * Importing it executes the build (it is a top-level, self-running script), so
 * this shim simply forwards to it. No logic is duplicated here.
 */

import "./build-frontend.mjs";
