#!/usr/bin/env node
// Compatibility entry point for persistence across a new control-plane port.
// Requires an already-built UI; use --help for Playwright flags and prerequisites.
import { runUiRegression } from './run-ui-regression.mjs';
runUiRegression('preferences survive a new control-plane port');
