'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  parseTasks,
  stripJsonc,
  stripLabelPrefix,
  projectReferences,
  expandVariables,
  resolveProjectPath,
} = require('../lib/tasksJson');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'workspace', '.vscode', 'tasks.json'),
  'utf8'
);

const FIXTURE_LABELS = [
  'clean',
  'build',
  'test',
  'verify',
  'watch',
  'release',
  'deploy',
  'package',
  'format',
  'docs',
  'Task Runner: lint',
];

const parse = (platform = 'linux') => parseTasks(FIXTURE, platform).tasks;
const find = (tasks, label) => tasks.find((task) => task.label === label);

describe('stripJsonc', () => {
  test('removes line and block comments', () => {
    const text = '{\n// note\n"a": 1, /* inline */\n"b": 2\n}';
    assert.deepStrictEqual(JSON.parse(stripJsonc(text)), { a: 1, b: 2 });
  });

  test('keeps a comma that is followed by another member', () => {
    const text = '{ "a": 1, "b": 2 }';
    assert.deepStrictEqual(JSON.parse(stripJsonc(text)), { a: 1, b: 2 });
  });

  test('drops a trailing comma even when a comment sits behind it', () => {
    const text = '{\n  "tasks": [\n    { "label": "a" }, // last\n  ],\n}';
    assert.deepStrictEqual(JSON.parse(stripJsonc(text)), { tasks: [{ label: 'a' }] });
  });

  test('preserves comma, brace, comment and star sequences inside strings', () => {
    const text = '{ "a": "x,} y // z /* w */ \\" q" }';
    assert.deepStrictEqual(JSON.parse(stripJsonc(text)), { a: 'x,} y // z /* w */ " q' });
  });

  test('tolerates a byte order mark', () => {
    assert.deepStrictEqual(JSON.parse(stripJsonc('\uFEFF{ "a": 1 }')), { a: 1 });
  });
});

describe('parseTasks', () => {
  test('reads the fixture, skipping hidden tasks', () => {
    assert.deepStrictEqual(parse().map((task) => task.label), FIXTURE_LABELS);
  });

  test('never throws on malformed input', () => {
    const result = parseTasks('{ "tasks": [ }', 'linux');
    assert.deepStrictEqual(result.tasks, []);
    assert.ok(result.error, 'expected an error message');
  });

  test('rejects a document that is not a JSON object', () => {
    assert.strictEqual(parseTasks('[]', 'linux').error, 'tasks.json must contain a JSON object');
  });

  test('ignores a tasks property that is not an array', () => {
    assert.deepStrictEqual(parseTasks('{ "tasks": {} }', 'linux'), { tasks: [] });
  });

  test('treats blank input as an empty task list', () => {
    assert.deepStrictEqual(parseTasks('', 'linux'), { tasks: [] });
    assert.deepStrictEqual(parseTasks('  \n\t ', 'linux'), { tasks: [] });
  });

  test('skips tasks without a label, matching the tasks.json schema', () => {
    const text = '{ "tasks": [ { "type": "shell", "command": "true" }, { "label": "kept" } ] }';
    assert.deepStrictEqual(parseTasks(text, 'linux').tasks.map((task) => task.label), ['kept']);
  });

  test('carries detail, group and command through', () => {
    const clean = find(parse(), 'clean');
    assert.strictEqual(clean.detail, 'Remove build output');
    assert.strictEqual(clean.group, 'build');
    assert.strictEqual(clean.command, 'rm -rf out');
    assert.strictEqual(clean.isCompound, false);
    assert.strictEqual(clean.dependsOn.length, 0);
  });

  test('normalises a group object down to its kind', () => {
    assert.strictEqual(find(parse(), 'build').group, 'build');
  });

  test('joins command arrays and drops non string argument objects', () => {
    const build = find(parse(), 'build');
    assert.strictEqual(build.command, 'make --jobs 4');
    assert.deepStrictEqual(build.args, ['4']);
  });

  test('accepts a single string as args', () => {
    assert.strictEqual(find(parse(), 'test').command, 'npm test');
  });

  test('describes an npm task by its script', () => {
    const npm = find(parse(), 'package');
    assert.strictEqual(npm.type, 'npm');
    assert.strictEqual(npm.command, 'npm run build');
  });

  test('marks a task without a type but with dependsOn as compound', () => {
    const verify = find(parse(), 'verify');
    assert.strictEqual(verify.isCompound, true);
    assert.strictEqual(verify.dependsOrder, 'sequence');
    assert.deepStrictEqual(verify.dependsOn, ['clean', 'build', 'lint']);
  });

  test('does not flag provider references as missing dependencies', () => {
    assert.deepStrictEqual(find(parse(), 'verify').missingDeps, []);
    assert.deepStrictEqual(find(parse(), 'docs').missingDeps, ['missing-task']);
  });

  test('flags background tasks', () => {
    assert.strictEqual(find(parse(), 'watch').isBackground, true);
    assert.strictEqual(find(parse(), 'clean').isBackground, false);
  });

  test('detects tasks that ask for input', () => {
    assert.strictEqual(find(parse(), 'deploy').needsInput, true);
    assert.strictEqual(find(parse(), 'clean').needsInput, false);
  });

  test('applies the platform specific command override', () => {
    assert.strictEqual(find(parse('linux'), 'release').command, 'make release-linux');
    assert.strictEqual(find(parse('win32'), 'release').command, 'nmake release');
    assert.strictEqual(find(parse('darwin'), 'release').command, 'gmake release');
  });

  test('keeps the shared task properties when an override applies', () => {
    assert.strictEqual(find(parse('win32'), 'release').group, undefined);
    assert.strictEqual(find(parse('win32'), 'release').label, 'release');
  });
});

describe('stripLabelPrefix', () => {
  test('trims a matching prefix', () => {
    assert.strictEqual(stripLabelPrefix('Task Runner: Full Cleanup', 'Task Runner: '), 'Full Cleanup');
  });

  test('keeps labels that do not match or would become empty', () => {
    assert.strictEqual(stripLabelPrefix('build', 'Task Runner: '), 'build');
    assert.strictEqual(stripLabelPrefix('Task Runner: ', 'Task Runner: '), 'Task Runner: ');
    assert.strictEqual(stripLabelPrefix('build', ''), 'build');
  });
});

describe('projectReferences', () => {
  test('picks out solution and project file arguments', () => {
    const args = ['format', 'style', '${workspaceFolder}/App.slnx', '--severity', 'info'];
    assert.deepStrictEqual(projectReferences(args), ['${workspaceFolder}/App.slnx']);
  });

  test('ignores everything else', () => {
    assert.deepStrictEqual(projectReferences(['format', '--folder', '.']), []);
    assert.deepStrictEqual(projectReferences(undefined), []);
  });
});

describe('expandVariables', () => {
  const variables = { workspaceFolder: '/w/app', workspaceFolderBasename: 'app' };

  test('expands known variables', () => {
    assert.strictEqual(
      expandVariables('${workspaceFolder}/${workspaceFolderBasename}.slnx', variables),
      '/w/app/app.slnx'
    );
  });

  test('leaves unknown variables as written', () => {
    assert.strictEqual(expandVariables('${env:HOME}/x', variables), '${env:HOME}/x');
  });
});

describe('resolveProjectPath', () => {
  test('expands the workspace folder variable', () => {
    assert.strictEqual(
      resolveProjectPath('${workspaceFolder}/${workspaceFolderBasename}.slnx', '/w/app'),
      '/w/app/app.slnx'
    );
  });

  test('anchors a relative path to the workspace root', () => {
    assert.strictEqual(resolveProjectPath('App.csproj', '/w/app'), '/w/app/App.csproj');
  });

  test('tolerates a trailing separator on the root', () => {
    assert.strictEqual(resolveProjectPath('${workspaceFolder}/a.sln', '/w/app/'), '/w/app/a.sln');
  });
});
