#!/usr/bin/env node
/**
 * Executable entry point for `watch-tail`.
 *
 * Kept separate from {@link ./index.ts} so the module can be imported (by tests)
 * without running anything.
 */
import { main } from './index.ts';

void main();
