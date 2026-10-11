'use strict';

// The quick pick and the actual task launch.
//
// Tasks are started with the `workbench.action.tasks.runTask` command, passing the
// exact label, instead of with `tasks.executeTask()`.
//
// Reason: `tasks.fetchTasks()` does not carry `dependsOn` on the objects it returns
// (microsoft/vscode#106946), so a compound task handed to `executeTask()` loses the
// chain it is made of. The `runTask` command resolves the label inside VS Code, which
// rebuilds the full `dependsOn` graph. A label that does not match exactly makes
// VS Code open a filtered quick pick, so the menu shows the shortened label while the
// command always receives the full one.

const vscode = require('vscode');
const { stripLabelPrefix } = require('./tasksJson');

const RECENT_KEY = 'task-runner.recent';

function detailFor(task) {
  if (task.detail) {
    return task.detail;
  }
  if (task.dependsOn.length > 0) {
    return task.dependsOn.join(task.dependsOrder === 'sequence' ? ' -> ' : ' + ');
  }
  return task.command;
}

function toQuickPickItem(task, multiRoot, labelPrefix) {
  const badges = [];
  if (multiRoot) {
    badges.push(`$(root-folder) ${task.folder.name}`);
  }
  if (task.isCompound) {
    badges.push('$(rocket) compound');
  }
  if (task.needsInput) {
    badges.push('$(edit) needs input');
  }
  if (task.missingDeps.length > 0) {
    badges.push(`$(warning) missing dependency: ${task.missingDeps.join(', ')}`);
  }
  if (task.missing.length > 0) {
    badges.push('$(warning) file not found');
  }

  const flagged = task.missing.length > 0 || task.missingDeps.length > 0;
  let iconPath;
  if (flagged) {
    iconPath = new vscode.ThemeIcon('warning');
  } else if (task.isCompound) {
    iconPath = new vscode.ThemeIcon('rocket');
  }

  return {
    label: `$(play) ${stripLabelPrefix(task.label, labelPrefix)}`,
    description: badges.length > 0 ? badges.join('  ') : undefined,
    detail: detailFor(task),
    iconPath,
    task,
  };
}

/** False when the workspace is not trusted, in which case no task may be started. */
async function ensureTrusted() {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    'Task Runner: this workspace is not trusted, so VS Code will not run tasks.',
    'Manage Workspace Trust'
  );
  if (choice) {
    await vscode.commands.executeCommand('workbench.trust.manage');
  }
  return false;
}

/** Asks before starting a task whose project or solution file is missing on disk. */
async function confirmMissingInputs(task, labelPrefix) {
  if (task.missing.length === 0) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `Task Runner: "${stripLabelPrefix(task.label, labelPrefix)}" needs ${task.missing[0]}, `
      + 'which does not exist, so the task will most likely fail.',
    'Run anyway',
    'Open tasks.json'
  );
  if (choice === 'Open tasks.json') {
    if (task.tasksFileUri) {
      await vscode.window.showTextDocument(task.tasksFileUri);
    }
    return false;
  }
  return choice === 'Run anyway';
}

async function runTask(context, task, labelPrefix) {
  if (!(await ensureTrusted())) {
    return;
  }
  if (!(await confirmMissingInputs(task, labelPrefix))) {
    return;
  }
  await context.workspaceState.update(RECENT_KEY, {
    label: task.label,
    folderUri: task.folder.uri.toString(),
  });
  await vscode.commands.executeCommand('workbench.action.tasks.runTask', task.label);
}

/**
 * Opens the quick pick, grouped by task group, with the most recently used task on top.
 *
 * @param {vscode.ExtensionContext} context
 * @param {import('./taskStore').TaskStore} store
 * @param {() => string} getLabelPrefix
 */
async function showTaskPicker(context, store, getLabelPrefix) {
  if (!(await ensureTrusted())) {
    return;
  }

  const labelPrefix = getLabelPrefix();
  const tasks = store.tasks;
  if (tasks.length === 0) {
    vscode.window.showInformationMessage(
      'Task Runner: no runnable task found. Add one to your tasks.json.'
    );
    return;
  }

  const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
  const recent = context.workspaceState.get(RECENT_KEY);
  const recentTask =
    recent &&
    tasks.find(
      (task) => task.label === recent.label && task.folder.uri.toString() === recent.folderUri
    );
  const rest = tasks.filter((task) => task !== recentTask);

  const sections = [
    ['Recently used', recentTask ? [recentTask] : []],
    ['Build', rest.filter((task) => task.group === 'build')],
    ['Test', rest.filter((task) => task.group === 'test')],
    ['Other', rest.filter((task) => task.group !== 'build' && task.group !== 'test')],
  ].filter(([, list]) => list.length > 0);

  const items = [];
  for (const [title, list] of sections) {
    if (sections.length > 1) {
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(...list.map((task) => toQuickPickItem(task, multiRoot, labelPrefix)));
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Task Runner',
    placeHolder: 'Select a task to run',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (picked && picked.task) {
    await runTask(context, picked.task, labelPrefix);
  }
}

/**
 * Entry point for the hover links in the status bar tooltip.
 *
 * @param {string} label Exact task label.
 * @param {string} [folderUri] Workspace folder the link came from.
 */
async function runTaskByLabel(context, store, label, folderUri, getLabelPrefix) {
  const task = store.tasks.find(
    (entry) => entry.label === label && (!folderUri || entry.folder.uri.toString() === folderUri)
  );
  if (!task) {
    vscode.window.showWarningMessage(`Task Runner: no task named "${label}".`);
    return;
  }
  await runTask(context, task, getLabelPrefix());
}

module.exports = { showTaskPicker, runTaskByLabel };
