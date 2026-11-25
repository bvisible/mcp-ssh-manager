/**
 * Split a shell command line into the simple commands it would run, for the
 * per-server security policy.
 *
 * The policy used to test its regexes against the whole command line. An
 * allow pattern such as `^docker ps` therefore only checked how a line
 * started, and `docker ps; id` passed (GHSA-rfxw-26h6-7w42); a deny pattern
 * such as `^rm ` missed `echo x; rm -rf /data` for the same reason. Splitting
 * the line lets every command in a list or pipeline be checked on its own.
 *
 * This is a conservative reader, not a shell. Whatever it cannot place with
 * confidence is reported so the caller can refuse it: command substitution
 * (`$(…)`, backticks), process substitution, redirections that write to a
 * file, and the constructs below.
 *
 * What makes a reader like this unsafe is not what it refuses but where it
 * and the shell disagree about which text is quoted or a comment: whatever the
 * reader thinks is hidden, it does not check, and whatever it thinks is live
 * but the shell has hidden, it can swallow a real command into a quote
 * (GHSA-86xm-rv3h-r4f2). So:
 *
 *   - a `#` at the start of a word is a comment, to the end of its line, and
 *     the text of it is dropped: an apostrophe or a backslash in a comment must
 *     not open a quote or join two lines. `\<newline>` is a line continuation, which
 *     the shell removes before it looks for a comment, so it changes nothing here;
 *   - a `#` the shells read differently (next to `<>(){}`) is refused;
 *   - an unquoted `(` or `)` is refused: it is a subshell to sh, and a command to
 *     zsh (`=(cmd)`, `*(e:cmd:)`) and fish (`(cmd)`);
 *   - what hides text from this reader and that shells read in their own way is
 *     refused rather than guessed: here-documents (`<<`), ANSI-C quotes
 *     (`$'…'`, where `\'` does not end the string in bash, ksh and zsh but does
 *     in dash), and a `${…}` that is more than a plain name (`${x:-word}`,
 *     `${x#pattern}`, ksh's and bash's `${ command; }`).
 *
 * Each of those sets `problem` and the reading goes on as before, so a caller
 * that only wants the segments (readonly mode) still gets them.
 */

const CONTROL_OPERATORS = /^(;;|;&|&&|\|\||\|&)/;
const HARMLESS_WRITE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** `${name}`, `${#name}`, `${1}`, `${@}`: a parameter, and nothing the shell reads further. */
const PLAIN_EXPANSION = /^\$\{(?:#?[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\}/;

/**
 * Index of the `)` closing the `(` at `open`, skipping quoted text and nested
 * parentheses, or -1 when there is none.
 * @param {string} text
 * @param {number} open
 */
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '\'') {
      const end = text.indexOf('\'', i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) return -1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the backtick closing the one before `start`, or -1.
 * @param {string} text
 * @param {number} start
 */
function closingBacktick(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') return i;
  }
  return -1;
}

/**
 * @typedef {object} ShellSegments
 * @property {string[]} segments - Each simple command, trimmed, in order
 * @property {string[]} substitutions - The command text inside every `$(…)`,
 *   backtick pair or process substitution, split the same way, nested ones included
 * @property {string[]} writes - Targets of redirections that open a file for
 *   writing; /dev/null, /dev/stdout, /dev/stderr and descriptor copies (`2>&1`)
 *   are not listed
 * @property {string|null} problem - Why the line could not be read, if it could not
 */

/**
 * @param {string} command
 * @returns {ShellSegments}
 */
export function splitShellCommand(command) {
  /** @type {ShellSegments} */
  const result = { segments: [], substitutions: [], writes: [], problem: null };
  const text = String(command);
  let current = '';
  // True where a word could start: the start of the line, after unescaped blanks
  // and after ; & | or a newline. A `#` there is a comment; anywhere else it is
  // part of a word (`a#b`, `$#`, `16#ff`).
  let wordStart = true;

  const endSegment = () => {
    if (current.trim()) result.segments.push(current.trim());
    current = '';
  };
  /** @param {string} body */
  const addSubstitution = body => {
    const inner = splitShellCommand(body);
    result.substitutions.push(...inner.segments, ...inner.substitutions);
    result.writes.push(...inner.writes);
    result.problem ||= inner.problem;
    if (!inner.segments.length && !inner.substitutions.length) result.substitutions.push(body);
  };
  /** @param {string} reason */
  const fail = reason => {
    result.problem = reason;
    return result;
  };
  /**
   * Something this reader will not guess at. The line is not fit to be allowed,
   * but reading goes on, so the segments found are still reported.
   * @param {string} reason
   */
  const refuse = reason => {
    result.problem ||= reason;
  };

  for (let i = 0; i < text.length;) {
    const ch = text[i];

    if (ch === '\\') {
      // A backslash and a newline are removed by the shell before it reads
      // anything else: they leave the state of the word as it was.
      current += text.slice(i, i + 2);
      if (text[i + 1] !== '\n') wordStart = false;
      i += 2;
      continue;
    }
    if (ch === '#') {
      if (wordStart) {
        // A comment: to the end of the line, and nothing in it is read.
        const newline = text.indexOf('\n', i);
        i = newline < 0 ? text.length : newline;
        continue;
      }
      if ('<>(){}'.includes(text[i - 1] ?? '')) refuse('a # next to a bracket or a redirection, which shells read differently');
    }
    if (ch === '\'') {
      const end = text.indexOf('\'', i + 1);
      if (end < 0) return fail('an unterminated single quote');
      current += text.slice(i, end + 1);
      wordStart = false;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // Double quotes do not stop $(…) or backticks from running.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          const plain = PLAIN_EXPANSION.exec(text.slice(j));
          if (plain) { j += plain[0].length; continue; }
          refuse('a ${…} with an operator or a word in it, which shells read in their own way');
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = closingParen(text, j + 1);
          if (end < 0) return fail('an unterminated $(');
          addSubstitution(text.slice(j + 2, end));
          j = end + 1;
          continue;
        }
        if (text[j] === '`') {
          const end = closingBacktick(text, j + 1);
          if (end < 0) return fail('an unterminated backtick');
          addSubstitution(text.slice(j + 1, end));
          j = end + 1;
          continue;
        }
        j++;
      }
      if (j >= text.length) return fail('an unterminated double quote');
      current += text.slice(i, j + 1);
      wordStart = false;
      i = j + 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '\'') {
      refuse('ANSI-C quoting ($\'…\'), where shells disagree on where the string ends');
    }
    if (ch === '$' && text[i + 1] === '{') {
      const plain = PLAIN_EXPANSION.exec(text.slice(i));
      if (plain) {
        current += plain[0];
        wordStart = false;
        i += plain[0].length;
        continue;
      }
      refuse('a ${…} with an operator or a word in it, which shells read in their own way');
    }
    if (ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        // <<< is a here-string: one word, no body.
        current += '<<<';
        wordStart = false;
        i += 3;
        continue;
      }
      refuse('a here-document (<<), whose body is not a list of commands');
    }
    if ((ch === '$' || ch === '<' || ch === '>') && text[i + 1] === '(') {
      // $(…) command substitution, <(…) and >(…) process substitution.
      const end = closingParen(text, i + 1);
      if (end < 0) return fail(`an unterminated ${ch}(`);
      addSubstitution(text.slice(i + 2, end));
      current += text.slice(i, end + 1);
      wordStart = false;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = closingBacktick(text, i + 1);
      if (end < 0) return fail('an unterminated backtick');
      addSubstitution(text.slice(i + 1, end));
      current += text.slice(i, end + 1);
      wordStart = false;
      i = end + 1;
      continue;
    }
    if (ch === '>' || (ch === '&' && text[i + 1] === '>') || (ch === '<' && text[i + 1] === '>')) {
      // >, >>, >|, &>, &>>, >&N and <> all open something for writing.
      let j = i + (ch === '>' ? 1 : 2);
      if (ch !== '<' && (text[j] === '>' || text[j] === '|')) j++;
      let copiesDescriptor = false;
      if (text[j] === '&') { copiesDescriptor = true; j++; }
      while (text[j] === ' ' || text[j] === '\t') j++;
      let k = j;
      while (k < text.length && !/[\s;&|<>()]/.test(text[k])) k++;
      const target = text.slice(j, k);
      const harmless = (copiesDescriptor && /^(\d+|-)$/.test(target))
        || (ch !== '<' && HARMLESS_WRITE_TARGETS.has(target));
      if (!harmless) result.writes.push(target || '(no target)');
      current += text.slice(i, k);
      wordStart = false;
      i = k;
      continue;
    }
    if (ch === '(' || ch === ')') {
      // sh reads these as a subshell or a function body, never inside an argument; other shells
      // run commands from them: zsh's =(cmd) and glob qualifiers *(e:cmd:), fish's (cmd).
      // The login shell reads the line when it is not wrapped in `sh -c` (a timeout of
      // 300000, a session), so it is not enough to be right about sh.
      refuse('an unquoted parenthesis, which zsh and fish read as a command');
      current += ch;
      wordStart = false;
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      endSegment();
      wordStart = true;
      const operator = CONTROL_OPERATORS.exec(text.slice(i));
      i += operator ? operator[0].length : 1;
      continue;
    }
    current += ch;
    // Only a space or a tab is a blank to the shells; a form feed or a carriage return is part of a word.
    wordStart = ch === ' ' || ch === '\t';
    i++;
  }

  endSegment();
  return result;
}

// ── What the shell makes of a command before it runs ───────────────────────────────
//
// The deny patterns are written against the name of a command (`\brm\b`, `^rm `). A
// shell does not run the text it was given: it removes quotes and backslashes,
// joins lines at a backslash-newline, replaces a name that holds nothing with
// nothing, splits a word at the blanks a name holds, and expands braces. `r""m`,
// `r\m`, `r${x}m` and a backslash and a newline between the `r` and the `m` are all
// `rm` (GHSA-4fp4-fggm-cf5c). A pattern tested only against what was typed
// is therefore tested against a command the shell does not run, and any
// allowed command that starts another one (`find -exec`, `xargs`, `env`, `sed`,
// `awk`, `tar`, `git`, `make`, an interpreter) lets the rest through.
//
// Everything above is a fixed rewrite, so it is read the same way the shell reads
// it and the pattern is tested on the result as well. What stands for text the
// reader cannot know (`$_`, `${x:-word}`, `{a,b}`: a line can make any of them
// spell a name) is reported, and restricted mode refuses it.
// What no reader can follow stays out of reach: a glob (`/bin/r?`), the value of a
// variable the line does not set, the text an interpreter runs (`sh -c`, `python -c`).
// A deny pattern is a guard rail against those, never a boundary around them.

const BRACE_GROUP = /^(?:\{[^{}\s]*(?:,[^{}\s]*)+\}|\{[^{}\s,]*\.\.[^{}\s,]*\})/;
/** A word before the command: `NAME=value`, or a redirection. */
const ASSIGNMENT_OR_REDIRECTION = /^(?:[A-Za-z_][A-Za-z0-9_]*=|\d*[<>]|&>)/;
const NAME_EXPANSION = /^\$([A-Za-z_][A-Za-z0-9_]*)/;
/** Combinations a brace expansion is read to, so `{a,b}{c,d}{e,f}…` cannot grow without end. */
const BRACE_READINGS = 64;

/**
 * Length of the `${…}` at the start of `text`, nested ones counted; the rest of the text when it never closes.
 * @param {string} text
 */
function bracedLength(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$' && text[i + 1] === '{') { depth++; i++; continue; }
    if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Index of the quote ending the `$'…'` at the start of `text`, where bash, ksh
 * and zsh read `\'` as a quote inside the string; -1 when it never ends.
 * @param {string} text
 */
function ansiCEnd(text) {
  for (let i = 2; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '\'') return i;
  }
  return -1;
}

/**
 * The characters a `$'…'` string stands for: hexadecimal, octal and unicode
 * escapes and the usual letters; any other escaped character stands for itself.
 * @param {string} body
 */
function decodeAnsiC(body) {
  const letters = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g, (_all, code) => {
    if (code[0] === 'x' && code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
    if (/^[uU]/.test(code) && code.length > 1) return String.fromCodePoint(Math.min(parseInt(code.slice(1), 16), 0x10ffff));
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8) & 0xff);
    return Object.hasOwn(letters, code) ? letters[code] : code;
  });
}

/**
 * Remove every backslash-newline pair the shell would remove: all of them outside
 * single quotes, and before anything else is read (`$\<newline>@` is `$@`).
 * @param {string} text
 */
function joinLines(text) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle) {
      if (text[i + 1] === '\n') { i++; continue; }
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '\'' && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    out += ch;
  }
  return out;
}

/**
 * Read one simple command the way the shell does before running it.
 *
 * @param {string} original - One segment, as `splitShellCommand` returned it
 * @returns {{unquoted: string, bare: string, spaced: string, defaulted: string, unreadable: string|null, guessed: string|null}}
 *   `unquoted`: quotes, backslashes and line continuations removed, names left in;
 *   `bare`: also with every name removed, as when it is unset;
 *   `spaced`: with every name replaced by a blank, as when it holds blanks;
 *   `defaulted`: with `${name:-word}` replaced by its word, as when the name is unset;
 *   `unreadable`: the first thing found that no reading follows (`$_`);
 *   `guessed`: the first thing found that is read by guesses (`${x:-word}`, `{a,b}`)
 */
function readOne(original) {
  const text = joinLines(original);
  let unquoted = '';
  let bare = '';
  let spaced = '';
  let defaulted = '';
  /** @type {string|null} */
  let unreadable = null;
  /** @type {string|null} */
  let guessed = null;
  let inDouble = false;
  /** @param {string} s */
  const plain = s => { unquoted += s; bare += s; spaced += s; defaulted += s; };
  /** @param {string} s */
  const expansion = s => { unquoted += s; spaced += ' '; };
  /**
   * `$_` is the last argument of the command before it: a line can set it
   * (`echo m; r$_`), so it is the one name the reader cannot treat as empty.
   * Every other name is read as unset, or as holding blanks, and the line cannot give it a value.
   * @param {string} name
   */
  const classify = name => {
    if (name.replace(/^#/, '') === '_') unreadable ||= 'the parameter $_, which holds the last argument of the command before it';
  };

  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      // A backslash that ends the text is dropped by sh, bash, ksh and zsh (dash keeps it).
      if (next === undefined) { i++; continue; }
      if (next === '\n') { i += 2; continue; }
      // In double quotes a backslash only escapes these four characters.
      if (inDouble && !'$`"\\'.includes(next)) plain(ch);
      plain(next);
      i += 2;
      continue;
    }
    if (ch === '\'' && !inDouble) {
      const end = text.indexOf('\'', i + 1);
      plain(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') { inDouble = !inDouble; i++; continue; }
    if (ch === '$') {
      const rest = text.slice(i);
      // $"…" is a quote with a translation; $'…' is a quote with escapes (bash, ksh, zsh).
      if (!inDouble && rest[1] === '"') { i++; continue; }
      if (!inDouble && rest[1] === '\'') {
        const end = ansiCEnd(rest);
        plain(decodeAnsiC(rest.slice(2, end < 0 ? rest.length : end)));
        i += end < 0 ? rest.length : end + 1;
        continue;
      }
      const braced = PLAIN_EXPANSION.exec(rest);
      if (braced) {
        classify(braced[0].slice(2, -1));
        expansion(braced[0]);
        i += braced[0].length;
        continue;
      }
      if (rest[1] === '{') {
        guessed ||= 'a ${…} with an operator or a word in it, which can stand for any text';
        const length = bracedLength(rest);
        // ${name:-word}, ${name-word}, ${name:=word}, ${name=word}: the word, when the name is unset.
        const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([\s\S]*)\}$/.exec(rest.slice(0, length));
        if (fallback) defaulted += readOne(fallback[1]).unquoted;
        expansion(rest.slice(0, length));
        i += length;
        continue;
      }
      if (rest[1] === '(') {
        // $(…) and $((…)): read as holding nothing, as `r$(true)m` is `rm`; what is inside is checked on its own.
        const end = closingParen(rest, 1);
        const length = end < 0 ? rest.length : end + 1;
        expansion(rest.slice(0, length));
        i += length;
        continue;
      }
      const named = NAME_EXPANSION.exec(rest);
      if (named) {
        classify(named[1]);
        expansion(named[0]);
        i += named[0].length;
        continue;
      }
      // $! is the last background job, and there is none in a command line of its own.
      if (/^\$[0-9@*!-]/.test(rest)) {
        expansion(rest.slice(0, 2));
        i += 2;
        continue;
      }
      if (/^\$[?#$]/.test(rest)) { plain(rest.slice(0, 2)); i += 2; continue; }
      plain('$');
      i++;
      continue;
    }
    if (ch === '`') {
      const end = closingBacktick(text, i + 1);
      const length = (end < 0 ? text.length : end + 1) - i;
      expansion(text.slice(i, i + length));
      i += length;
      continue;
    }
    if (ch === '{' && !inDouble && BRACE_GROUP.test(text.slice(i))) {
      guessed ||= 'a brace expansion ({a,b}, {1..3}), which sh does not expand and bash, ksh and zsh do';
    }
    plain(ch);
    i++;
  }
  return { unquoted, bare, spaced, defaulted, unreadable, guessed };
}

/**
 * What a text becomes when its brace expansions are carried out, for the
 * groups a shell would expand: `r{m,}` is `rm` and `r`.
 * @param {string} text
 * @returns {string[]}
 */
function expandBraces(text) {
  let results = [text];
  for (let round = 0; round < 8; round++) {
    const next = [];
    let changed = false;
    for (const current of results) {
      const group = /\{([^{}\s]*(?:,[^{}\s]*)+)\}/.exec(current);
      if (!group) { next.push(current); continue; }
      changed = true;
      for (const alternative of group[1].split(',')) {
        next.push(current.slice(0, group.index) + alternative + current.slice(group.index + group[0].length));
      }
    }
    results = next.slice(0, BRACE_READINGS);
    if (!changed) break;
  }
  return results;
}

/**
 * `/bin/rm -rf x` runs `rm`: the same command with the directory of its name left out.
 * @param {string} text
 */
function withoutDirectory(text) {
  const words = text.split(/([ \t]+)/);
  let index = 0;
  while (index < words.length && ASSIGNMENT_OR_REDIRECTION.test(words[index])) index += 2;
  if (index >= words.length || !words[index].includes('/')) return null;
  words[index] = words[index].slice(words[index].lastIndexOf('/') + 1);
  return words.join('');
}

/** A word that is one quoted string with nothing the shell would act on inside it. */
const QUOTED_STRING = /^(?:'[^']*'|"[^"$`\\]*")$/;
/** What a word that starts another command follows: `find -exec "rm"`, `xargs "rm"`, `env "rm"`. */
const LAUNCHERS = new Set(['-exec', '-execdir', '-ok', '-okdir', 'xargs', 'env', 'nice', 'nohup', 'time', 'timeout',
  'exec', 'command', 'builtin', 'setsid', 'stdbuf', 'ionice', 'watch', 'parallel', 'flock', 'doas']);

/**
 * The words of a simple command, each with the blanks after it: split at a space or a tab that is not
 * quoted, escaped or inside `$(…)`, backticks or `${…}`.
 * @param {string} text
 * @returns {{text: string, gap: string}[]}
 */
function splitWords(text) {
  /** @type {{text: string, gap: string}[]} */
  const words = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\'') {
      const end = text.indexOf('\'', i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '{') { i += bracedLength(text.slice(i)); continue; }
    if (ch === '`') {
      const end = closingBacktick(text, i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      let end = i;
      while (text[end] === ' ' || text[end] === '\t') end++;
      words.push({ text: text.slice(start, i), gap: text.slice(i, end) });
      start = end;
      i = end;
      continue;
    }
    i++;
  }
  if (start < text.length) words.push({ text: text.slice(start), gap: '' });
  return words;
}

/**
 * Every reading of each command, for patterns that name a command to refuse:
 * the text as typed first, then what the shell makes of it (see above).
 *
 * @param {string[]} segments - What `splitShellCommand` returned
 * @returns {{texts: string[], unreadable: string|null, guessed: string|null}}
 *   `unreadable`: something no reading follows (`$_`), to refuse in every mode;
 *   `guessed`: something read by guesses (`${x:-word}`, `{a,b}`), which a mode
 *   that holds the line to an allowlist refuses
 */
export function readSegments(segments) {
  const texts = new Set();
  /** @type {string|null} */
  let unreadable = null;
  /** @type {string|null} */
  let guessed = null;
  for (const segment of segments) {
    texts.add(segment);
    const words = splitWords(segment);
    const readings = words.map(word => readOne(word.text));
    for (const reading of readings) {
      unreadable ||= reading.unreadable;
      guessed ||= reading.guessed;
    }
    // A word that is only a quoted string (`"kill -9"`) is an argument: it is read
    // as typed, or `grep "service x restart" log` would be a `service x restart`.
    // It is read when it can be the command: the first word, or the one after a launcher.
    let commandSeen = false;
    const kept = words.map((word, index) => {
      const isCommand = !commandSeen && !ASSIGNMENT_OR_REDIRECTION.test(word.text);
      if (isCommand) commandSeen = true;
      return !isCommand && !LAUNCHERS.has(words[index - 1]?.text ?? '') && QUOTED_STRING.test(word.text);
    });
    for (const kind of /** @type {const} */ (['unquoted', 'bare', 'spaced', 'defaulted'])) {
      const text = words.map((word, index) => (kept[index] ? word.text : readings[index][kind]) + word.gap).join('');
      for (const variant of expandBraces(text)) {
        const trimmed = variant.trim();
        texts.add(trimmed);
        const bare = withoutDirectory(trimmed);
        if (bare) texts.add(bare);
      }
    }
  }
  texts.delete('');
  return { texts: [...texts], unreadable, guessed };
}

/**
 * Why the name of the command in a segment cannot be trusted as typed, or null.
 * An allow pattern is tested on the text as typed, so a name that is written with
 * a quote, a backslash, a name or a glob (`ls""x`, `\ls`, `/bin/r?`) is not
 * the name the pattern was matched against.
 *
 * @param {string} segment
 * @returns {string|null}
 */
export function commandWordProblem(segment) {
  const words = segment.split(/[ \t]+/);
  let index = 0;
  // `NAME=value` before the command, and a redirection, are not the command.
  while (index < words.length && ASSIGNMENT_OR_REDIRECTION.test(words[index])) index++;
  const word = words[index] ?? '';
  if (word === '[' || word === '[[') return null;
  if (/['"\\$*?[{`]/.test(word)) {
    return 'the name of the command is written with a quote, a backslash, a variable or a glob, so it is not the name the pattern was matched against';
  }
  return null;
}

