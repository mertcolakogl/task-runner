'use strict';

// End to end test of extension.js without VS Code.
//
// A fake `vscode` module is put into the require cache through `Module._load`, so
// the real extension runs and every status bar and quick pick call is recorded. This
// checks more than "it loads": it checks which command is invoked, with which label,
// and what the status bar shows while a task runs.
//
// The `vscode` module is CommonJS, which is exactly why this interception works.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');

const FIXTURES = path.join(__dirname, 'fixtures');
// A workspace shaped like a real one, so the tests exercise the default tasks file path
// instead of pointing the setting at a loose file.
const WORKSPACE = path.join(FIXTURES, 'workspace');

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

// ------------------------------------------------------------------ fake vscode

const state = {
  workspaceFolders: [],
  isTrusted: true,
  settings: {},
  statusItem: undefined,
  quickPickItems: undefined,
  quickPickAnswer: undefined,
  quickPickOptions: undefined,
  warningAnswer: undefined,
  warnings: [],
  informations: [],
  opened: [],
  executed: [],
  handlers: new Map(),
  listeners: {},
  watcherPattern: undefined,
  showCount: 0,
  hideCount: 0,
  workspaceState: new Map(),
};

const disposable = () => ({ dispose() {} });

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return disposable();
    };
  }
  fire(value) {
    for (const listener of this._listeners) {
      listener(value);
    }
  }
  dispose() {
    this._listeners.length = 0;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value || '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

const uri = (fsPath) => ({
  fsPath,
  toString() {
    return `file://${fsPath}`;
  },
});

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  EventEmitter,
  MarkdownString,
  ThemeIcon,
  ThemeColor,

  Uri: {
    joinPath(base, ...parts) {
      return uri(path.join(base.fsPath, ...parts));
    },
    file(fsPath) {
      return uri(fsPath);
    },
  },

  window: {
    createStatusBarItem(id, alignment, priority) {
      const item = {
        id,
        alignment,
        priority,
        // In VS Code a status bar item is invisible until show() is called.
        visible: false,
        text: undefined,
        name: undefined,
        command: undefined,
        tooltip: undefined,
        backgroundColor: undefined,
        accessibilityInformation: undefined,
        show() {
          state.showCount++;
          item.visible = true;
        },
        hide() {
          state.hideCount++;
          item.visible = false;
        },
        dispose: disposable,
      };
      state.statusItem = item;
      return item;
    },
    async showQuickPick(items, options) {
      state.quickPickItems = items;
      state.quickPickOptions = options;
      return state.quickPickAnswer;
    },
    async showWarningMessage(message, ...actions) {
      state.warnings.push({ message, actions });
      return state.warningAnswer;
    },
    async showInformationMessage(message) {
      state.informations.push(message);
      return undefined;
    },
    async showTextDocument(target) {
      state.opened.push(target);
      return undefined;
    },
  },

  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    get isTrusted() {
      return state.isTrusted;
    },
    getConfiguration(section) {
      return {
        get(key) {
          return state.settings[`${section}.${key}`];
        },
      };
    },
    fs: {
      async readFile(target) {
        return fs.promises.readFile(target.fsPath);
      },
      async stat(target) {
        return fs.promises.stat(target.fsPath);
      },
    },
    createFileSystemWatcher(pattern) {
      state.watcherPattern = pattern;
      return {
        onDidCreate: disposable,
        onDidChange: disposable,
        onDidDelete: disposable,
        dispose() {},
      };
    },
    onDidChangeWorkspaceFolders(listener) {
      state.listeners.workspaceFolders = listener;
      return disposable();
    },
    onDidGrantWorkspaceTrust(listener) {
      state.listeners.trust = listener;
      return disposable();
    },
    onDidChangeConfiguration(listener) {
      state.listeners.configuration = listener;
      return disposable();
    },
  },

  commands: {
    registerCommand(id, handler) {
      state.handlers.set(id, handler);
      return disposable();
    },
    async executeCommand(id, ...args) {
      state.executed.push({ id, args });
    },
  },

  tasks: {
    onDidStartTask(listener) {
      state.listeners.start = listener;
      return disposable();
    },
    onDidEndTask(listener) {
      state.listeners.end = listener;
      return disposable();
    },
    onDidEndTaskProcess(listener) {
      state.listeners.process = listener;
      return disposable();
    },
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Point TASK_RUNNER_EXTENSION at an unpacked .vsix to run this whole suite against the
// packaged artifact instead of the working tree.
const EXTENSION_PATH = process.env.TASK_RUNNER_EXTENSION
  ? path.resolve(process.env.TASK_RUNNER_EXTENSION)
  : path.join(__dirname, '..', 'extension.js');

const extension = require(EXTENSION_PATH);

// ------------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const folder = (name, fsPath) => ({ name, uri: uri(fsPath) });

const runsOfTask = () =>
  state.executed.filter((entry) => entry.id === 'workbench.action.tasks.runTask');

const separators = () =>
  state.quickPickItems
    .filter((item) => item.kind === vscode.QuickPickItemKind.Separator)
    .map((item) => item.label);

const quickPickTasks = () => state.quickPickItems.filter((item) => item.task);

/** VS Code shows no hover when the tooltip carries no content. */
const hoverOpen = () => Boolean(state.statusItem.tooltip && state.statusItem.tooltip.value);

function itemFor(label) {
  const item = quickPickTasks().find((entry) => entry.task.label === label);
  assert.ok(item, `no quick pick item for "${label}"`);
  return item;
}

function makeContext() {
  const subscriptions = [];
  return {
    subscriptions,
    workspaceState: {
      get: (key) => state.workspaceState.get(key),
      update: async (key, value) => state.workspaceState.set(key, value),
    },
    dispose() {
      for (const subscription of subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // the fake throws on nothing; dispose must still clear the rest
        }
      }
      subscriptions.length = 0;
    },
  };
}

function clearCalls() {
  state.warnings = [];
  state.informations = [];
  state.opened = [];
  state.executed = [];
  state.quickPickItems = undefined;
  state.quickPickAnswer = undefined;
  state.quickPickOptions = undefined;
  state.warningAnswer = undefined;
  state.showCount = 0;
  state.hideCount = 0;
}

async function openPicker() {
  await state.handlers.get('task-runner.runTask')();
  return state.quickPickItems;
}

/** Answers the open quick pick with the task of the given label. */
function pick(label) {
  const item = itemFor(label);
  state.quickPickAnswer = item;
  return item;
}

const runTaskEvent = (name, extra = {}) => ({
  execution: { task: { name, source: 'Workspace', isBackground: false, ...extra } },
});

// ----------------------------------------------------------------------- tests

describe('extension', () => {
  let context;

  beforeEach(async () => {
    clearCalls();
    // No settings at all, deliberately: the tests then run against the very defaults the
    // extension contributes, including `.vscode/tasks.json`.
    state.settings = {};
    state.workspaceFolders = [folder('workspace', WORKSPACE)];
    state.isTrusted = true;
    state.workspaceState.clear();
    state.handlers.clear();

    context = makeContext();
    await extension.activate(context);
  });

  afterEach(() => {
    context.dispose();
  });

  describe('status bar', () => {
    test('creates the entry and reports the task count', () => {
      assert.strictEqual(state.statusItem.id, 'task-runner.status');
      assert.strictEqual(state.statusItem.alignment, vscode.StatusBarAlignment.Left);
      assert.strictEqual(state.statusItem.command, 'task-runner.runTask');
      assert.strictEqual(state.statusItem.name, 'Task Runner');
      assert.strictEqual(state.statusItem.text, '$(task-runner-idle)');
      assert.strictEqual(state.statusItem.visible, true, 'the entry was never shown');
      assert.match(state.statusItem.tooltip.value, /11 tasks/);
    });

    test('links every task from the hover, plus a way to show all', () => {
      const tooltip = state.statusItem.tooltip.value;
      assert.match(tooltip, /command:task-runner\.runTaskByLabel\?/);
      assert.match(tooltip, /Show all\]\(command:task-runner\.runTask\)/);
      // The command links only work in a trusted tooltip.
      assert.strictEqual(state.statusItem.tooltip.isTrusted, true);
    });

    test('watches the default tasks file with no setting configured', () => {
      assert.deepStrictEqual(state.settings, {}, 'the tests should run on defaults only');
      assert.strictEqual(state.watcherPattern, '**/.vscode/tasks.json');
    });

    test('hides the entry when the tasks file is absent', async () => {
      context.dispose();
      state.workspaceFolders = [folder('no-tasks', FIXTURES)];
      context = makeContext();
      await extension.activate(context);

      assert.strictEqual(state.statusItem.visible, false, 'the entry should be hidden');
      await state.handlers.get('task-runner.runTask')();
      assert.strictEqual(state.informations.length, 1);
      assert.match(state.informations[0], /no runnable task/);
      assert.strictEqual(runsOfTask().length, 0);
    });

    test('hides the entry again when the tasks file disappears', async () => {
      assert.strictEqual(state.statusItem.visible, true, 'the fixture should have shown it');

      state.settings['task-runner.tasksFile'] = 'does-not-exist.json';
      state.listeners.configuration({ affectsConfiguration: () => true });
      await sleep(60);

      assert.strictEqual(state.statusItem.visible, false, 'the entry outlived its tasks file');
    });
  });

  describe('quick pick', () => {
    test('lists every task, skipping the hidden one', async () => {
      await openPicker();
      assert.deepStrictEqual(
        quickPickTasks().map((item) => item.task.label),
        FIXTURE_LABELS
      );
    });

    test('groups tasks and omits an empty section', async () => {
      await openPicker();
      assert.deepStrictEqual(separators(), ['Build', 'Test', 'Other']);
    });

    test('shows the abbreviated label in the menu', async () => {
      await openPicker();
      assert.strictEqual(itemFor('clean').label, '$(play) clean');
    });

    test('keeps the full label when no prefix is configured', async () => {
      await openPicker();
      assert.strictEqual(itemFor('Task Runner: lint').label, '$(play) Task Runner: lint');
    });

    test('strips the configured label prefix', async () => {
      context.dispose();
      state.settings['task-runner.labelPrefix'] = 'Task Runner: ';
      context = makeContext();
      await extension.activate(context);

      await openPicker();
      assert.strictEqual(itemFor('Task Runner: lint').label, '$(play) lint');
      // A label without the prefix is left alone.
      assert.strictEqual(itemFor('clean').label, '$(play) clean');
    });

    test('matches on the detail text', async () => {
      await openPicker();
      assert.strictEqual(state.quickPickOptions.matchOnDetail, true);
      assert.strictEqual(state.quickPickOptions.placeHolder, 'Select a task to run');
    });

    test('badges a compound task and marks it with a rocket', async () => {
      await openPicker();
      const verify = itemFor('verify');

      assert.strictEqual(verify.iconPath.id, 'rocket');
      assert.match(verify.description, /compound/);
      // The gutter icon and the inline badge spell the same codicon; they should not drift.
      assert.match(verify.description, /\$\(rocket\) compound/);
      assert.strictEqual(verify.detail, 'Clean, build and test in order');
    });

    test('falls back to the dependency chain as detail', async () => {
      await openPicker();
      assert.strictEqual(itemFor('docs').detail, 'missing-task + npm: lint');
    });

    test('flags a task whose file is missing', async () => {
      await openPicker();
      const format = itemFor('format');
      assert.match(format.description, /file not found/);
      assert.strictEqual(format.iconPath.id, 'warning');
      assert.deepStrictEqual(format.task.missing, [path.join(WORKSPACE, 'App.slnx')]);
    });

    test('flags a dependency that is not defined in the file', async () => {
      await openPicker();
      assert.match(itemFor('docs').description, /missing dependency: missing-task/);
    });

    test('marks a task that asks for input', async () => {
      await openPicker();
      assert.match(itemFor('deploy').description, /needs input/);
    });
  });

  describe('running', () => {
    test('runs the picked task under its full label', async () => {
      await openPicker();
      pick('clean');
      await state.handlers.get('task-runner.runTask')();

      const runs = runsOfTask();
      assert.strictEqual(runs.length, 1);
      assert.deepStrictEqual(runs[0].args, ['clean']);
    });

    test('does nothing when the quick pick is dismissed', async () => {
      await openPicker();
      state.quickPickAnswer = undefined;
      await state.handlers.get('task-runner.runTask')();
      assert.strictEqual(runsOfTask().length, 0);
    });

    test('remembers the last task and puts it in its own section', async () => {
      await openPicker();
      pick('clean');
      await state.handlers.get('task-runner.runTask')();

      clearCalls();
      await openPicker();

      assert.deepStrictEqual(separators(), ['Recently used', 'Build', 'Test', 'Other']);
      assert.strictEqual(quickPickTasks()[0].task.label, 'clean');
    });

    test('runs a task through the hover link command', async () => {
      const folderUri = uri(WORKSPACE).toString();
      await state.handlers.get('task-runner.runTaskByLabel')('verify', folderUri);

      const runs = runsOfTask();
      assert.strictEqual(runs.length, 1);
      assert.deepStrictEqual(runs[0].args, ['verify']);
    });

    test('warns about an unknown label from a hover link', async () => {
      await state.handlers.get('task-runner.runTaskByLabel')('nope');
      assert.strictEqual(runsOfTask().length, 0);
      assert.match(state.warnings[0].message, /no task named "nope"/);
    });
  });

  describe('missing inputs', () => {
    test('asks before starting a task whose file is missing', async () => {
      await openPicker();
      pick('format');
      await state.handlers.get('task-runner.runTask')();

      assert.strictEqual(runsOfTask().length, 0);
      assert.strictEqual(state.warnings.length, 1);
      assert.match(state.warnings[0].message, /App\.slnx/);
      assert.deepStrictEqual(state.warnings[0].actions, ['Run anyway', 'Open tasks.json']);
    });

    test('starts the task after "Run anyway"', async () => {
      await openPicker();
      pick('format');
      state.warningAnswer = 'Run anyway';
      await state.handlers.get('task-runner.runTask')();

      const runs = runsOfTask();
      assert.strictEqual(runs.length, 1);
      assert.deepStrictEqual(runs[0].args, ['format']);
    });

    test('opens the tasks file and stops after "Open tasks.json"', async () => {
      await openPicker();
      pick('format');
      state.warningAnswer = 'Open tasks.json';
      await state.handlers.get('task-runner.runTask')();

      assert.strictEqual(runsOfTask().length, 0);
      assert.strictEqual(state.opened.length, 1);
      assert.strictEqual(
        state.opened[0].fsPath,
        path.join(WORKSPACE, '.vscode', 'tasks.json')
      );
    });
  });

  describe('workspace trust', () => {
    test('refuses to open the picker in an untrusted workspace', async () => {
      state.isTrusted = false;
      await state.handlers.get('task-runner.runTask')();

      assert.strictEqual(state.quickPickItems, undefined);
      assert.strictEqual(state.warnings.length, 1);
      assert.match(state.warnings[0].message, /not trusted/);
      assert.deepStrictEqual(state.warnings[0].actions, ['Manage Workspace Trust']);
      assert.strictEqual(runsOfTask().length, 0);
    });

    test('opens the trust dialog when asked', async () => {
      state.isTrusted = false;
      state.warningAnswer = 'Manage Workspace Trust';
      await state.handlers.get('task-runner.runTask')();

      assert.deepStrictEqual(
        state.executed.map((entry) => entry.id),
        ['workbench.trust.manage']
      );
    });
  });

  describe('run indicator', () => {
    test('wobbles the carrot while a task runs', async () => {
      state.listeners.start(runTaskEvent('clean'));
      await sleep(250);
      assert.match(state.statusItem.text, /^\$\(task-runner-(left|idle|right)\)$/);
    });

    test('shows an error mark and a red background when a task fails', async () => {
      state.listeners.start(runTaskEvent('clean'));
      state.listeners.process({ exitCode: 1, execution: runTaskEvent('clean').execution });
      state.listeners.end(runTaskEvent('clean'));
      await sleep(600); // settle delay before the result is shown

      assert.strictEqual(state.statusItem.text, '$(error)');
      assert.strictEqual(state.statusItem.backgroundColor.id, 'statusBarItem.errorBackground');
    });

    test('shows a check mark when a task succeeds', async () => {
      state.listeners.start(runTaskEvent('clean'));
      state.listeners.process({ exitCode: 0, execution: runTaskEvent('clean').execution });
      state.listeners.end(runTaskEvent('clean'));
      await sleep(600);

      assert.strictEqual(state.statusItem.text, '$(check)');
      assert.strictEqual(state.statusItem.backgroundColor, undefined);
    });

    test('never moves for a background task', async () => {
      state.listeners.start(runTaskEvent('watch', { isBackground: true }));
      await sleep(250);
      assert.strictEqual(state.statusItem.text, '$(task-runner-idle)');
    });

    test('closes the hover on start and keeps it closed for the whole run', async () => {
      const before = state.statusItem.tooltip;
      assert.ok(before.value, 'the fixture should have produced a tooltip');

      state.listeners.start(runTaskEvent('clean'));
      assert.strictEqual(hoverOpen(), false, 'the hover was not closed');

      state.listeners.process({ exitCode: 0, execution: runTaskEvent('clean').execution });
      state.listeners.end(runTaskEvent('clean'));
      assert.strictEqual(hoverOpen(), false, 'the hover reopened mid run');

      await sleep(600); // the settle delay before the result mark
      assert.strictEqual(state.statusItem.text, '$(check)');
      assert.strictEqual(hoverOpen(), true, 'the tooltip was never restored');
      assert.strictEqual(state.statusItem.tooltip.value, before.value);
    });

    test('a background task leaves the hover alone', () => {
      const before = state.statusItem.tooltip;
      state.listeners.start(runTaskEvent('watch', { isBackground: true }));
      assert.strictEqual(state.statusItem.tooltip, before, 'a background task hid the hover');
    });

    test('uses a primitive isTrusted, which survives the trip to VS Code', () => {
      // VS Code compares tooltips with markdownStringEqual, which tests isTrusted by
      // reference. Every status bar update re-sends the tooltip over the extension host RPC,
      // and an object would be deserialised into a fresh one every time, so it would never
      // compare equal. VS Code answers a changed tooltip by rebuilding the open hover, and
      // the carrot updates its text on every animation frame.
      assert.strictEqual(
        typeof state.statusItem.tooltip.isTrusted,
        'boolean',
        'an object isTrusted would make the hover flicker on every animation frame'
      );
    });
  });

  describe('broken tasks file', () => {
    // Written at run time rather than committed, so the whole life of a broken file can be
    // walked: it breaks, it is reported once, it is fixed, and it breaks again.
    let brokenWorkspace;
    let brokenTasksFile;

    const writeTasksFile = (contents) => fs.writeFileSync(brokenTasksFile, contents, 'utf8');
    const refresh = async () => {
      state.listeners.trust(); // the extension rereads every folder on this event
      await sleep(80);
    };

    beforeEach(() => {
      brokenWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runner-broken-'));
      fs.mkdirSync(path.join(brokenWorkspace, '.vscode'));
      brokenTasksFile = path.join(brokenWorkspace, '.vscode', 'tasks.json');
    });

    afterEach(() => {
      fs.rmSync(brokenWorkspace, { recursive: true, force: true });
    });

    test('warns once, forgets a fix, and warns again on a new breakage', async () => {
      writeTasksFile('{ "tasks": [ }');

      context.dispose();
      state.workspaceFolders = [folder('broken', brokenWorkspace)];
      context = makeContext();
      await extension.activate(context);

      assert.strictEqual(state.warnings.length, 1);
      assert.match(state.warnings[0].message, /cannot read \.vscode\/tasks\.json/);

      // Reading the same broken file again must not warn again.
      await refresh();
      assert.strictEqual(state.warnings.length, 1, 'the same error was reported twice');

      // Fixing it must not warn, and must clear the record of what was reported.
      writeTasksFile('{ "version": "2.0.0", "tasks": [] }');
      await refresh();
      assert.strictEqual(state.warnings.length, 1, 'a fixed file was still reported');

      // Breaking it anew is news again; a recorded error must not silence it forever.
      writeTasksFile('{ "tasks": [ }');
      await refresh();
      assert.strictEqual(state.warnings.length, 2, 'a new breakage went unreported');
    });
  });
});

// The icon ids are spelled in two places, lib/icons.js and package.json, and the images
// are referenced by path from package.json and README.md. Nothing in VS Code or GitHub
// connects either pair, so a rename that touches only one side breaks silently: the status
// bar shows an unresolvable `$(...)` token, or the README shows a broken image. These
// tests are the connection.
describe('contributed assets', () => {
  const manifest = require('../package.json');
  const icons = require('../lib/icons');
  const repositoryRoot = path.join(__dirname, '..');

  test('every icon id the extension uses is contributed', () => {
    const contributed = Object.keys(manifest.contributes.icons);
    for (const id of new Set([icons.IDLE, ...icons.WOBBLE])) {
      assert.ok(contributed.includes(id), `$( ${id} ) is used but not contributed`);
    }
  });

  test('every contributed icon points at a font that exists', () => {
    for (const [id, entry] of Object.entries(manifest.contributes.icons)) {
      const fontPath = entry.default.fontPath;
      assert.ok(
        fs.existsSync(path.join(repositoryRoot, fontPath)),
        `${id} points at ${fontPath}, which does not exist`
      );
    }
  });

  test('every contributed icon has its own glyph in the private use area', () => {
    const characters = Object.values(manifest.contributes.icons).map(
      (entry) => entry.default.fontCharacter
    );
    assert.strictEqual(new Set(characters).size, characters.length, 'two icons share a glyph');
    for (const character of characters) {
      assert.match(character, /^\\F1[0-9A-F]{2}$/);
    }
  });

  test('the status bar default is the idle carrot', () => {
    const properties = manifest.contributes.configuration.properties;
    assert.strictEqual(properties['task-runner.statusBarText'].default, `$(${icons.IDLE})`);
  });

  test('the wobble frames are distinct', () => {
    assert.strictEqual(new Set(icons.WOBBLE).size, 3);
    assert.strictEqual(icons.WOBBLE[1], icons.IDLE);
    assert.strictEqual(icons.WOBBLE[3], icons.IDLE);
  });

  test('every local image the README points at exists', () => {
    const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
    // HTML comments are stripped: the demo slot documents a recording that does not exist yet.
    const visible = readme.replace(/<!--[\s\S]*?-->/g, '');
    const targets = [
      ...[...visible.matchAll(/src="([^"]+)"/g)].map((match) => match[1]),
      ...[...visible.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    ].filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));

    assert.ok(targets.length > 0, 'the README header logo disappeared');
    for (const target of targets) {
      assert.ok(
        fs.existsSync(path.join(repositoryRoot, target)),
        `README.md points at ${target}, which does not exist`
      );
    }
  });
});
