#!/usr/bin/env node
// Compatibility entry point. No URL/token or screenshot-directory arguments:
// isolated Playwright fixtures own the server and browser. Use --help for flags.
import { runUiRegression } from './run-ui-regression.mjs';
runUiRegression('welcome is accessible|welcome fits a narrow viewport');
