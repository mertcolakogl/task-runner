# Task Runner <img align="left" width="48px" height="48px" src="images/task-runner-logo-512.png" alt="Task Runner logo" />

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC)
![License](https://img.shields.io/badge/license-MIT-green)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

Run the tasks from your `tasks.json` straight from the status bar. One carrot, one click
and a quick pick built from the file you already maintain.

There is no second list to keep in sync. The labels and the `detail` texts in the menu are
the ones written in `tasks.json`.

<!--
Demo goes here. Record the status bar, hovering it and the quick pick, then replace this
comment with:

    ![Task Runner in action](images/demo.gif)

A GIF of a few seconds, under about 5 MB, is ideal.
-->

## Features

- **The menu is your file.** Labels, `detail` lines and order all come from `tasks.json`.
  Nothing to write twice, nothing that can drift apart.
- **Grouped and searchable.** The quick pick splits into **Recently used**, **Build**,
  **Test** and **Other**. It filters as you type, matching on the label, the detail and the
  badges.
- **It tells you it is running.** The carrot wobbles while a task runs. When it finishes, a
  check mark, or an error mark on a red status bar, stays up for three seconds.
- **It warns before something fails.** A task is annotated when a `dependsOn` entry is not
  defined in the file, when it asks for `${input:...}`, or when a project or solution file
  it points at is missing. The last one is confirmed before anything starts, because a task
  such as `dotnet format style <solution>` otherwise dies with an unhandled exception.
- **At home in any workspace.** Every folder of a multi-root workspace contributes its own
  tasks, each tagged with its folder name. `extensionKind` is `workspace`, so it also works
  over Remote SSH, WSL and dev containers.
- **Respects Workspace Trust.** In an untrusted workspace no task is started. A warning with
  a **Manage Workspace Trust** button is shown instead.
- **No dependencies, no build step.** Plain CommonJS. The repository never needs
  `node_modules` and the `.vsix` is built with `zip`.

## Getting started

Install from the Marketplace or from a release:

```sh
code --install-extension task-runner-*.vsix
```

1. Open a folder that has a `.vscode/tasks.json`.
2. Click the carrot on the left of the status bar and pick a task.

The carrot only appears while at least one workspace folder has a tasks file and it hides
itself again if that file goes away. The file is watched, so an edit shows up in the menu
without reloading the window.

Hovering the carrot lists the first few tasks as links, so a task can be started without
opening the menu at all. Starting one that way closes the hover and leaves it closed while
the task runs, so it does not sit over the task output.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `task-runner.tasksFile` | `.vscode/tasks.json` | Path of the tasks file, relative to each workspace folder root |
| `task-runner.labelPrefix` | *(empty)* | Shared prefix stripped from labels in the picker. Leave empty to show labels exactly as written |
| `task-runner.statusBarText` | `$(task-runner-idle)` | Status bar text. Any codicon works, for example `$(task-runner-idle) Tasks` |

## Commands

| Command | Description |
| --- | --- |
| **Task Runner: Run Task...** | Opens the quick pick. This is what the status bar carrot is bound to |
| **Task Runner: Run Task by Label** | Runs a single task by its exact label. Kept out of the command palette; the hover links use it |

## Requirements

- VS Code 1.85 or newer.
- A `tasks.json`, in `.vscode` or wherever `task-runner.tasksFile` points. It is JSONC, so
  comments and trailing commas are fine.

## Release notes

See [CHANGELOG.md](https://github.com/mertcolakogl/task-runner/blob/main/CHANGELOG.md).

## How it works

Tasks are started with the `workbench.action.tasks.runTask` command, passing the exact
label, rather than with `tasks.executeTask()`. `tasks.fetchTasks()` does not carry
`dependsOn` on the objects it returns
([microsoft/vscode#106946](https://github.com/microsoft/vscode/issues/106946)), so a
compound task handed to `executeTask()` would lose the chain it is made of. Resolving the
label inside VS Code rebuilds the whole `dependsOn` graph.

## Contributing

Issues and pull requests are welcome at
[github.com/mertcolakogl/task-runner](https://github.com/mertcolakogl/task-runner).

```sh
npm test        # every test, including an end-to-end one against a fake vscode module
tools/pack.sh   # build the .vsix without npm or vsce
```

The tests need Node 20 or newer. Nothing else does: `npm test` is only `node --test` and
packaging is a POSIX shell script using `zip` and `unzip`. The extension itself has no
runtime dependency, so `node_modules` never appears and users never need Node.

## License

[MIT](https://github.com/mertcolakogl/task-runner/blob/main/LICENSE)
