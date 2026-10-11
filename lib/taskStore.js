'use strict';

// Reads the tasks file of every workspace folder and keeps one flat, current list
// of everything the user can run.
//
// Disk changes are picked up by a single file system watcher and the read itself is
// debounced, so a burst of writes cannot queue up a burst of parses. Every read is
// tagged with a sequence number: a read that finishes after a newer one started is
// discarded instead of overwriting fresher data.

const vscode = require('vscode');
const { parseTasks } = require('./tasksJson');
const { resolveMissingInputs } = require('./missingInputs');

const REFRESH_DEBOUNCE_MS = 200;

/** `workspace.fs.stat` reduced to a boolean, for the missing input check. */
async function fileExists(absolutePath) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
    return true;
  } catch {
    return false;
  }
}

class TaskStore {
  /**
   * @param {() => string} getTasksFile Relative path of the tasks file. Read on every
   *   refresh so a settings change takes effect without rebuilding the store.
   */
  constructor(getTasksFile) {
    this._getTasksFile = getTasksFile;
    this._emitter = new vscode.EventEmitter();
    this._watcher = undefined;
    this._timer = undefined;
    this._sequence = 0;

    /** Every task of every workspace folder, each carrying `folder` and `missing`. */
    this.tasks = [];
    /** Workspace folders whose tasks file exists but could not be parsed. */
    this.errors = [];
    /** Fires whenever `tasks` or `errors` changed. */
    this.onDidChange = this._emitter.event;
  }

  async start() {
    this.resetWatcher();
    await this.refresh();
  }

  /** Recreates the watcher, for example after the tasks file setting changed. */
  resetWatcher() {
    if (this._watcher) {
      this._watcher.dispose();
    }
    this._watcher = vscode.workspace.createFileSystemWatcher(`**/${this._getTasksFile()}`);
    this._watcher.onDidCreate(() => this.scheduleRefresh());
    this._watcher.onDidChange(() => this.scheduleRefresh());
    this._watcher.onDidDelete(() => this.scheduleRefresh());
  }

  /** Coalesces the refreshes triggered by a burst of file system events. */
  scheduleRefresh() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  /** Reads every workspace folder and publishes the combined task list. */
  async refresh() {
    const sequence = ++this._sequence;
    const relative = this._getTasksFile();
    const tasks = [];
    const errors = [];

    for (const folder of vscode.workspace.workspaceFolders || []) {
      const uri = vscode.Uri.joinPath(folder.uri, relative);

      let text;
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        continue; // no tasks file in this folder: nothing to contribute
      }

      const result = parseTasks(text);
      if (result.error) {
        errors.push({ folder, error: result.error });
        continue;
      }

      const missing = await resolveMissingInputs(result.tasks, folder.uri.fsPath, fileExists);
      for (const task of result.tasks) {
        tasks.push({ ...task, folder, tasksFileUri: uri, missing: missing.get(task.label) || [] });
      }
    }

    if (sequence !== this._sequence) {
      return; // a newer read started while this one was running
    }

    this.tasks = tasks;
    this.errors = errors;
    this._emitter.fire();
  }

  dispose() {
    clearTimeout(this._timer);
    if (this._watcher) {
      this._watcher.dispose();
      this._watcher = undefined;
    }
    this._emitter.dispose();
  }
}

module.exports = { TaskStore };
