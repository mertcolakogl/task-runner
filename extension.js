'use strict';

// Task Runner: run tasks.json tasks from the status bar.
//
// The status bar holds a single carrot. Clicking it opens a quick pick built from
// every workspace folder's tasks file; picking an entry hands the task to VS Code's
// own task service, so output and problem matchers behave exactly as usual.

const vscode = require('vscode');
const { TaskStore } = require('./lib/taskStore');
const { createStatusBar } = require('./lib/statusBar');
const { showTaskPicker, runTaskByLabel } = require('./lib/quickPick');
const { IDLE, icon } = require('./lib/icons');

const CONFIG_SECTION = 'task-runner';
const RUN_TASK_COMMAND = 'task-runner.runTask';
const RUN_TASK_BY_LABEL_COMMAND = 'task-runner.runTaskByLabel';

/** Settings are read on demand, so a change takes effect without a reload. */
function config() {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    tasksFile: settings.get('tasksFile') || '.vscode/tasks.json',
    labelPrefix: settings.get('labelPrefix') || '',
    statusBarText: settings.get('statusBarText') || icon(IDLE),
  };
}

async function activate(context) {
  const store = new TaskStore(() => config().tasksFile);
  context.subscriptions.push(store);

  createStatusBar(context, store, () => config().statusBarText);

  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_TASK_COMMAND, () =>
      showTaskPicker(context, store, () => config().labelPrefix)
    ),
    vscode.commands.registerCommand(RUN_TASK_BY_LABEL_COMMAND, (label, folderUri) =>
      runTaskByLabel(context, store, label, folderUri, () => config().labelPrefix)
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => store.scheduleRefresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => store.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        store.resetWatcher();
        store.refresh();
      }
    })
  );

  // Report a broken tasks file once. It is reported again only after it was fixed
  // and broke anew, so a file that stays broken cannot spam notifications.
  const notified = new Set();
  context.subscriptions.push(
    store.onDidChange(() => {
      const current = new Set();
      for (const { folder, error } of store.errors) {
        const key = `${folder.uri.toString()}|${error}`;
        current.add(key);
        if (!notified.has(key)) {
          notified.add(key);
          vscode.window.showWarningMessage(
            `Task Runner: cannot read ${config().tasksFile} in ${folder.name}: ${error}`
          );
        }
      }
      for (const key of notified) {
        if (!current.has(key)) {
          notified.delete(key);
        }
      }
    })
  );

  await store.start();
}

function deactivate() {}

module.exports = { activate, deactivate };
