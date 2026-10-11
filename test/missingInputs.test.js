'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { missingInputs, inheritedMissing, resolveMissingInputs } = require('../lib/missingInputs');

const ROOT = '/w/app';

/** Builds a `fileExists` stub from the list of paths that should be present. */
const withFiles = (...present) => {
  const files = new Set(present);
  return async (absolutePath) => files.has(absolutePath);
};

const task = (label, args = [], dependsOn = []) => ({ label, args, dependsOn });

describe('missingInputs', () => {
  test('reports a solution file that is not on disk', async () => {
    const format = task('format', ['format', 'style', '${workspaceFolder}/App.slnx']);
    assert.deepStrictEqual(await missingInputs(format, ROOT, withFiles()), [`${ROOT}/App.slnx`]);
  });

  test('resolves a relative project path against the workspace root', async () => {
    const build = task('build', ['build', 'App.csproj']);
    assert.deepStrictEqual(await missingInputs(build, ROOT, withFiles()), [`${ROOT}/App.csproj`]);
  });

  test('says nothing when the file exists', async () => {
    const format = task('format', ['style', `${ROOT}/App.slnx`]);
    assert.deepStrictEqual(await missingInputs(format, ROOT, withFiles(`${ROOT}/App.slnx`)), []);
  });

  test('ignores arguments that are not project files', async () => {
    const clean = task('clean', ['format', 'whitespace', '--folder', '.']);
    assert.deepStrictEqual(await missingInputs(clean, ROOT, withFiles()), []);
  });

  test('collects every missing file of a task', async () => {
    const multi = task('multi', ['a.sln', 'b.csproj']);
    assert.deepStrictEqual(await missingInputs(multi, ROOT, withFiles(`${ROOT}/a.sln`)), [
      `${ROOT}/b.csproj`,
    ]);
  });
});

describe('inheritedMissing', () => {
  test('a compound task inherits the missing files of its dependencies', () => {
    const tasks = [
      task('style', ['style', 'App.slnx']),
      task('whitespace', ['whitespace', '--folder', '.']),
      task('verify', [], ['whitespace', 'style']),
    ];
    const byLabel = new Map(tasks.map((entry) => [entry.label, entry]));
    const ownByLabel = new Map([
      ['style', [`${ROOT}/App.slnx`]],
      ['whitespace', []],
      ['verify', []],
    ]);

    assert.deepStrictEqual(inheritedMissing(tasks[2], ownByLabel, byLabel, new Set()), [
      `${ROOT}/App.slnx`,
    ]);
  });

  test('reports a shared file only once', () => {
    const tasks = [
      task('a', ['a.sln']),
      task('b', ['a.sln']),
      task('top', [], ['a', 'b']),
    ];
    const byLabel = new Map(tasks.map((entry) => [entry.label, entry]));
    const ownByLabel = new Map([
      ['a', [`${ROOT}/a.sln`]],
      ['b', [`${ROOT}/a.sln`]],
      ['top', []],
    ]);

    assert.deepStrictEqual(inheritedMissing(tasks[2], ownByLabel, byLabel, new Set()), [
      `${ROOT}/a.sln`,
    ]);
  });

  test('ignores dependencies that are not defined in the file', () => {
    const tasks = [task('top', [], ['npm: lint', 'missing-task'])];
    const byLabel = new Map([['top', tasks[0]]]);
    const ownByLabel = new Map([['top', []]]);

    assert.deepStrictEqual(inheritedMissing(tasks[0], ownByLabel, byLabel, new Set()), []);
  });

  test('survives a dependency cycle', () => {
    const tasks = [task('a', ['a.sln'], ['b']), task('b', ['b.sln'], ['a'])];
    const byLabel = new Map(tasks.map((entry) => [entry.label, entry]));
    const ownByLabel = new Map([
      ['a', [`${ROOT}/a.sln`]],
      ['b', [`${ROOT}/b.sln`]],
    ]);

    assert.deepStrictEqual(inheritedMissing(tasks[0], ownByLabel, byLabel, new Set()), [
      `${ROOT}/a.sln`,
      `${ROOT}/b.sln`,
    ]);
  });
});

describe('resolveMissingInputs', () => {
  test('maps every label onto the files it needs', async () => {
    const tasks = [
      task('style', ['style', 'App.slnx']),
      task('whitespace', ['whitespace', '--folder', '.']),
      task('verify', [], ['whitespace', 'style']),
    ];

    const result = await resolveMissingInputs(tasks, ROOT, withFiles());

    assert.deepStrictEqual(result.get('style'), [`${ROOT}/App.slnx`]);
    assert.deepStrictEqual(result.get('whitespace'), []);
    assert.deepStrictEqual(result.get('verify'), [`${ROOT}/App.slnx`]);
  });

  test('returns an empty map for an empty task list', async () => {
    assert.strictEqual((await resolveMissingInputs([], ROOT, withFiles())).size, 0);
  });
});
