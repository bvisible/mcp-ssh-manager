#!/usr/bin/env node
// Compatibility entry point. Import assertions use temporary fixture config,
// never Transmit favourites or a caller's live vault. Use --help for the contract.
import { runUiRegression } from './run-ui-regression.mjs';
runUiRegression('import action in welcome|import is optional and keeps the original configuration');
