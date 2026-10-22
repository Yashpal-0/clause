import { inWorkspace } from '../helpers.ts';

// Claude changed line 2 and added a line at the end; the user then typed "my " at the start of line 5. Lines 3 and 4
// separate the typing from Claude's first block, and lines 6 and 7 separate it from the last, so it is a block of its own.
export const BEFORE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
export const AFTER = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\n';
export const FILE_WITH_TYPING = 'one\nTWO\nthree\nfour\nmy five\nsix\nseven\neight\n';

/** The same file in both runs: they share one workspace. */
export const restartFile = () => inWorkspace('restart/a.txt');
