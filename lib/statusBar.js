'use strict';

// The status bar entry: one carrot that opens the quick pick.
//
// It doubles as the run indicator. While non background tasks are running the
// carrot wobbles; when they finish, a check or an error mark stays up for a few
// seconds. Background tasks never end on their own, so they are left out of both.

const vscode = require('vscode');
const { WOBBLE, icon } = require('./icons');

const MAX_HOVER_TASKS = 8;
const ANIMATION_FRAME_MS = 150;
const SETTLE_MS = 400; // a short gap between chained tasks should not flash a result
const RESULT_MS = 3000; // how long the check or error mark stays up

/**
 * Tooltip content used while a run is in progress.
 *
 * VS Code disposes the open hover and shows nothing when the tooltip has no content, so an
 * empty MarkdownString is how the hover gets closed. An empty *string* will not do: the
 * extension host turns a falsy tooltip into `undefined`, and `undefined` is then dropped
 * from the update, leaving the previous tooltip in place.
 */
function emptyTooltip() {
  return new vscode.MarkdownString('');
}

/** Characters that carry meaning in Markdown link text, plus the `$(icon)` syntax. */
function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/\$\(/g, '\\$(');
}

/** `encodeURIComponent` leaves `(` and `)` alone, which would break a Markdown link. */
function encodeCommandArguments(args) {
  return encodeURIComponent(JSON.stringify(args)).replace(
    /[()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Identity of a task, used to count what is currently running. */
function taskKey(task) {
  const scope = task.scope && task.scope.uri ? task.scope.uri.toString() : String(task.scope);
  return `${scope}|${task.source}|${task.name}`;
}

/**
 * Creates the status bar item and keeps it in sync with the store and the task
 * service. Everything it registers goes into `context.subscriptions`.
 *
 * @param {vscode.ExtensionContext} context
 * @param {import('./taskStore').TaskStore} store
 * @param {() => string} getStatusBarText
 * @returns {vscode.StatusBarItem}
 */
function createStatusBar(context, store, getStatusBarText) {
  const item = vscode.window.createStatusBarItem(
    'task-runner.status',
    vscode.StatusBarAlignment.Left,
    100
  );
  item.name = 'Task Runner';
  item.command = 'task-runner.runTask';
  item.accessibilityInformation = { label: 'Run task', role: 'button' };
  item.text = getStatusBarText();

  const running = new Set();
  let phase = 'idle'; // idle | running | result
  let failed = false;
  let visible = false;
  let tooltipSuppressed = false;
  let settleTimer;
  let resultTimer;
  let frameTimer;
  let frame = 0;

  function startAnimation() {
    if (frameTimer) {
      return;
    }
    frameTimer = setInterval(() => {
      item.text = icon(WOBBLE[frame++ % WOBBLE.length]);
    }, ANIMATION_FRAME_MS);
  }

  function stopAnimation() {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = undefined;
    }
    frame = 0;
  }

  function renderTooltip() {
    // Empty while a run is under way; see suppressTooltip below.
    if (tooltipSuppressed) {
      item.tooltip = emptyTooltip();
      return;
    }

    const tasks = store.tasks;
    const markdown = new vscode.MarkdownString(undefined, true);

    // A primitive, deliberately. VS Code decides whether a tooltip changed with
    // `markdownStringEqual`, which tests `isTrusted` by reference. Every status bar update
    // re-sends the tooltip over the extension host RPC, and an object would be deserialised
    // into a fresh one each time, so it would never compare equal. VS Code answers a changed
    // tooltip by tearing the open hover down and building it again, and since the carrot
    // updates its text on every animation frame, the hover would flicker for the whole run.
    // `true` also keeps the `command:` links in this tooltip clickable, and the content here
    // is written by this extension with every task label escaped.
    markdown.isTrusted = true;

    // Nothing below may depend on what is currently running. The user opens this tooltip
    // by hovering and then starts a task by clicking inside it, so a tooltip that changes
    // during a run would be rebuilt under their cursor. The run indicator is the wobbling
    // carrot, not this text.
    markdown.appendMarkdown(`**Task Runner** - ${tasks.length} tasks\n\n`);

    for (const task of tasks.slice(0, MAX_HOVER_TASKS)) {
      const args = encodeCommandArguments([task.label, task.folder.uri.toString()]);
      markdown.appendMarkdown(
        `$(play) [${escapeMarkdown(task.label)}](command:task-runner.runTaskByLabel?${args})\n\n`
      );
    }
    if (tasks.length > MAX_HOVER_TASKS) {
      markdown.appendMarkdown(`_...and ${tasks.length - MAX_HOVER_TASKS} more_\n\n`);
    }
    markdown.appendMarkdown('---\n\n[$(list-selection) Show all](command:task-runner.runTask)');
    item.tooltip = markdown;
  }

  /**
   * Closes the hover and keeps it closed while a task runs.
   *
   * The status bar hover opens instantly and VS Code closes it when the entry is clicked,
   * only to reopen it because the pointer is still sitting on the entry. The user starts a
   * task by clicking inside that hover, so the popup would otherwise keep coming back over
   * the task output.
   *
   * An empty tooltip is the way to close it: VS Code disposes the open hover and, finding
   * no content, shows nothing. Emptying it also clears the content VS Code would use the
   * next time the pointer enters the entry, so it stays closed rather than reopening.
   */
  function suppressTooltip() {
    tooltipSuppressed = true;
    renderTooltip();
  }

  function restoreTooltip() {
    tooltipSuppressed = false;
    renderTooltip();
  }

  function refresh() {
    const shouldBeVisible = store.tasks.length > 0;
    if (shouldBeVisible !== visible) {
      visible = shouldBeVisible;
      if (shouldBeVisible) {
        item.show();
      } else {
        item.hide();
      }
    }
    if (phase === 'idle') {
      item.text = getStatusBarText();
    }
    renderTooltip();
  }

  function toIdle() {
    resultTimer = undefined;
    phase = 'idle';
    failed = false;
    item.backgroundColor = undefined;
    item.text = getStatusBarText();
    renderTooltip();
  }

  function finish() {
    settleTimer = undefined;
    stopAnimation();
    phase = 'result';
    item.text = failed ? '$(error)' : '$(check)';
    item.backgroundColor = failed ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    resultTimer = setTimeout(toIdle, RESULT_MS);
    restoreTooltip();
  }

  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      if (event.execution.task.isBackground) {
        return;
      }
      running.add(taskKey(event.execution.task));
      clearTimeout(settleTimer);
      settleTimer = undefined;
      if (phase !== 'running') {
        clearTimeout(resultTimer);
        resultTimer = undefined;
        failed = false;
        phase = 'running';
        item.backgroundColor = undefined;
        startAnimation();
      }
      suppressTooltip();
    }),

    vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.isBackground) {
        return;
      }
      // An undefined exit code means the user stopped the task; that is not a failure.
      if (event.exitCode !== undefined && event.exitCode !== 0) {
        failed = true;
      }
    }),

    vscode.tasks.onDidEndTask((event) => {
      if (event.execution.task.isBackground) {
        return;
      }
      running.delete(taskKey(event.execution.task));
      if (running.size === 0 && phase === 'running') {
        settleTimer = setTimeout(finish, SETTLE_MS);
      }
      renderTooltip();
    }),

    store.onDidChange(refresh),
    item,
    {
      dispose() {
        clearTimeout(settleTimer);
        clearTimeout(resultTimer);
        stopAnimation();
      },
    }
  );

  refresh();
  return item;
}

module.exports = { createStatusBar };
