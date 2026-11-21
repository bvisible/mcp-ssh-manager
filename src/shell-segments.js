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
