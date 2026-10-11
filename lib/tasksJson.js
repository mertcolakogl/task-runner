'use strict';

// Pure helpers for reading tasks.json.
//
// This module never imports `vscode`, so it can be unit tested with plain node
// (see test/tasksJson.test.js).
//
// tasks.json is JSONC: comments and trailing commas are legal. Both are removed
// before the text reaches JSON.parse. The scan is single pass and string aware, so
// `//`, `/*` and `,}` occurring inside string values survive untouched.
//
// A trailing comma cannot be decided on the spot: `, }` is one but `, "x"` is not,
// and comments or line breaks may sit in between. The comma is therefore held
// "pending" and only written or dropped once the next significant character shows up.

const PLATFORM_KEYS = { darwin: 'osx', win32: 'windows', linux: 'linux' };

/** Project and solution files a task may need on disk before it can run. */
const PROJECT_FILE = /\.(slnx?|slnf|csproj|vbproj|fsproj|proj)$/i;

/** Provider tasks are addressed as `npm: lint` and are not defined in tasks.json. */
const PROVIDER_LABEL = /^[\w-]+:\s/;

/** Strips JSONC comments and trailing commas, leaving every other byte alone. */
function stripJsonc(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let pendingComma = false;

  const flushComma = () => {
    if (pendingComma) {
      out += ',';
      pendingComma = false;
    }
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      flushComma();
      out += char;
      if (char === '\\') {
        out += next === undefined ? '' : next;
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      flushComma();
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    // Whitespace does not decide the comma's fate: it can still be written.
    if (/\s/.test(char)) {
      out += char;
      continue;
    }

    if (char === ',') {
      flushComma();
      pendingComma = true;
      continue;
    }

    if (char === '}' || char === ']') {
      pendingComma = false; // trailing comma: drop it
      out += char;
      continue;
    }

    flushComma();
    out += char;
  }

  return out;
}

/** Maps `process.platform` onto the key tasks.json uses for OS overrides. */
function platformKey(platform) {
  return PLATFORM_KEYS[platform] || 'linux';
}

/**
 * Flattens a string, an array of strings, or a `{ value, quoting }` command object
 * into one line of text. Mirrors how VS Code joins command arrays: with a space.
 */
function toText(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const text = value.map(toText).filter((part) => part !== undefined && part !== '');
    return text.length > 0 ? text.join(' ') : undefined;
  }
  if (typeof value === 'object' && typeof value.value === 'string') {
    return value.value;
  }
  return undefined;
}

/** The command line as the user would type it, for quick pick details and hovers. */
function commandText(task) {
  if (task.type === 'npm' && typeof task.script === 'string') {
    return `npm run ${task.script}`;
  }
  const command = toText(task.command);
  if (!command) {
    return undefined;
  }
  const args = toText(task.args);
  return args ? `${command} ${args}` : command;
}

/** `group` is either a plain string or `{ kind, isDefault }`. */
function groupKind(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && typeof value.kind === 'string') {
    return value.kind;
  }
  return undefined;
}

/**
 * A dependency is a plain label, a provider reference such as `npm: lint`, or a
 * `{ type, task }` identifier. Only plain labels can be checked against the labels
 * actually defined in the file, so everything else is marked as non local.
 */
function normalizeDependency(entry) {
  if (typeof entry === 'string') {
    return { label: entry, local: !PROVIDER_LABEL.test(entry) };
  }
  if (entry && typeof entry === 'object') {
    const label = entry.task || entry.label;
    if (typeof label === 'string' && label.length > 0) {
      return { label, local: false };
    }
  }
  return undefined;
}

/**
 * Turns tasks.json text into the flat list the user interface renders.
 *
 * Never throws: a malformed file yields `{ tasks: [], error }`, so one broken
 * workspace folder cannot take the whole menu down.
 *
 * @param {string} text
 * @param {string} [platform] A `process.platform` value.
 * @returns {{ tasks: object[], error?: string }}
 */
function parseTasks(text, platform = process.platform) {
  if (!text || !text.trim()) {
    return { tasks: [] };
  }

  let document;
  try {
    document = JSON.parse(stripJsonc(text));
  } catch (error) {
    return { tasks: [], error: error.message };
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { tasks: [], error: 'tasks.json must contain a JSON object' };
  }
  if (!Array.isArray(document.tasks)) {
    return { tasks: [] };
  }

  const overrideKey = platformKey(platform);
  const entries = document.tasks.filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  );

  // First pass: collect the labels so `missingDeps` can be resolved afterwards.
  const parsed = [];
  const labels = new Set();

  for (const raw of entries) {
    // An OS override contributes command details; it does not replace the task.
    const override = raw[overrideKey];
    const task =
      override && typeof override === 'object' && !Array.isArray(override)
        ? { ...raw, ...override }
        : raw;

    const label = typeof task.label === 'string' ? task.label : '';
    if (label.length === 0 || task.hide === true) {
      continue;
    }
    labels.add(label);
    parsed.push({ task, raw, label });
  }

  // Second pass: build the model the user interface consumes.
  const tasks = parsed.map(({ task, raw, label }) => {
    const dependencies = (Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn])
      .map(normalizeDependency)
      .filter((dependency) => dependency !== undefined);

    return {
      label,
      detail: typeof task.detail === 'string' && task.detail.length > 0 ? task.detail : undefined,
      type: typeof task.type === 'string' ? task.type : undefined,
      command: commandText(task),
      args: Array.isArray(task.args) ? task.args.filter((arg) => typeof arg === 'string') : [],
      group: groupKind(task.group),
      dependsOn: dependencies.map((dependency) => dependency.label),
      dependsOrder:
        task.dependsOrder === 'sequence' || task.dependsOrder === 'parallel'
          ? task.dependsOrder
          : undefined,
      // A task with no `type` of its own but with `dependsOn` only runs other tasks.
      isCompound: !task.type && dependencies.length > 0,
      isBackground: task.isBackground === true,
      needsInput: JSON.stringify(raw).includes('${input:'),
      missingDeps: dependencies
        .filter((dependency) => dependency.local && !labels.has(dependency.label))
        .map((dependency) => dependency.label),
    };
  });

  return { tasks };
}

/** Trims a shared label prefix (for example `Task Runner: `) so the menu stays readable. */
function stripLabelPrefix(label, prefix) {
  if (!prefix || !label.startsWith(prefix)) {
    return label;
  }
  const stripped = label.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : label;
}

/** Arguments that look like a project or solution file the task has to load. */
function projectReferences(args) {
  return (Array.isArray(args) ? args : []).filter(
    (arg) => typeof arg === 'string' && PROJECT_FILE.test(arg)
  );
}

/** Expands `${workspaceFolder}` style variables; unknown names are left as written. */
function expandVariables(value, variables) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match
  );
}

/** Resolves a possibly relative project path against the workspace folder root. */
function resolveProjectPath(reference, workspaceFolder) {
  const root = String(workspaceFolder).replace(/[\\/]+$/, '');
  const expanded = expandVariables(reference, {
    workspaceFolder: root,
    workspaceFolderBasename: root.split(/[\\/]/).pop(),
  });
  if (expanded.startsWith(root)) {
    return expanded;
  }
  return `${root}/${expanded}`;
}

module.exports = {
  stripJsonc,
  parseTasks,
  stripLabelPrefix,
  projectReferences,
  expandVariables,
  resolveProjectPath,
};
