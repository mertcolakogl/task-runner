'use strict';

// Icon ids contributed through `contributes.icons` in package.json.
//
// These are VS Code identifiers, not file names, and they are deliberately kept in
// kebab-case: every built-in codicon is spelled that way (`rocket`, `warning`,
// `root-folder`), and the ids also appear in user-visible `$(...)` tokens. Their spelling
// has to match package.json exactly, so test/smoke.test.js cross-checks the two.
//
// VS Code can only render an icon in a label as a font glyph, never as an image file, so
// the carrot ships as a three glyph font in assets/fonts/task-runner.woff. That file is a
// committed asset, not a build output: the SVGs in assets/assets-src are the artwork the
// glyphs were traced from, kept as the design record.

const IDLE = 'task-runner-idle';
const LEFT = 'task-runner-left';
const RIGHT = 'task-runner-right';

/** Left, centre, right, centre: a wobble rather than a snap around. */
const WOBBLE = [LEFT, IDLE, RIGHT, IDLE];

/** `$(icon)` label syntax for a contributed icon id. */
const icon = (id) => `$(${id})`;

module.exports = { IDLE, WOBBLE, icon };
