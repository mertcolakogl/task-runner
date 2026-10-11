'use strict';

// Pre-flight check for the project and solution files a task points at.
//
// A task such as `dotnet format style <solution>` fails with an unhandled tool
// exception when the file is absent, which tells the user nothing useful. So we
// read the arguments, expand VS Code variables, and report what is not on disk
// before anything is started.
//
// The file lookup is injected, which keeps this module free of `vscode` and lets
// it be unit tested with plain node.

const { projectReferences, resolveProjectPath } = require('./tasksJson');

/**
 * Project files this task asks for itself that are not on disk.
 *
 * @param {object} task A task from `parseTasks`.
 * @param {string} folderPath Absolute path of the workspace folder root.
 * @param {(absolutePath: string) => Promise<boolean>} fileExists
 * @returns {Promise<string[]>}
 */
async function missingInputs(task, folderPath, fileExists) {
  const missing = [];
  for (const reference of projectReferences(task.args)) {
    const target = resolveProjectPath(reference, folderPath);
    if (!(await fileExists(target))) {
      missing.push(target);
    }
  }
  return missing;
}

/**
 * A compound task carries no arguments of its own, so it inherits the missing
 * files of the tasks it depends on. `visited` keeps dependency cycles finite.
 *
 * @param {object} task
 * @param {Map<string, string[]>} ownByLabel Missing files per task, own arguments only.
 * @param {Map<string, object>} byLabel All tasks, keyed by label.
 * @param {Set<string>} visited
 * @returns {string[]}
 */
function inheritedMissing(task, ownByLabel, byLabel, visited) {
  const missing = [...(ownByLabel.get(task.label) || [])];
  if (visited.has(task.label)) {
    return missing;
  }
  visited.add(task.label);

  for (const label of task.dependsOn) {
    const dependency = byLabel.get(label);
    if (!dependency) {
      continue;
    }
    for (const file of inheritedMissing(dependency, ownByLabel, byLabel, visited)) {
      if (!missing.includes(file)) {
        missing.push(file);
      }
    }
  }
  return missing;
}

/**
 * Maps every task label onto the files that task needs but that are missing,
 * including the ones inherited through `dependsOn`.
 *
 * @param {object[]} tasks
 * @param {string} folderPath
 * @param {(absolutePath: string) => Promise<boolean>} fileExists
 * @returns {Promise<Map<string, string[]>>}
 */
async function resolveMissingInputs(tasks, folderPath, fileExists) {
  const byLabel = new Map(tasks.map((task) => [task.label, task]));

  const ownByLabel = new Map();
  for (const task of tasks) {
    ownByLabel.set(task.label, await missingInputs(task, folderPath, fileExists));
  }

  return new Map(
    tasks.map((task) => [task.label, inheritedMissing(task, ownByLabel, byLabel, new Set())])
  );
}

module.exports = { missingInputs, inheritedMissing, resolveMissingInputs };
