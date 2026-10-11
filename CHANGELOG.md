# Changelog

## 1.0.0

First public release.

- A single carrot in the status bar lists the tasks of every workspace folder and runs the
  one you pick.
- The quick pick is grouped into **Recently used**, **Build**, **Test** and **Other**. It
  shows the `detail` text of each task and filters as you type.
- Compound tasks (`dependsOn` without a `type`) run through
  `workbench.action.tasks.runTask` with their exact label, so the whole dependency chain
  survives.
- Tasks are annotated when a `dependsOn` entry is not defined in the file, when the task asks
  for `${input:...}`, or when a project or solution file it points at is missing. A missing
  file is confirmed before the task is started.
- The status bar doubles as the run indicator: the carrot wobbles while a task runs and a
  check or an error mark stays up for three seconds afterwards.
- No task is started in an untrusted workspace; a warning with a Workspace Trust button is
  shown instead.
- The carrot ships as a three glyph font, so the status bar icon can tilt left, sit upright
  and tilt right.
