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
 * (`$(…)`, backticks), process substitution, and redirections that write to a
 * file. It does not recognise comments, so `ls # a; b` yields a second segment
 * ` b` that a caller will refuse: a false refusal, never a missed command.
 */

const CONTROL_OPERATORS = /^(;;|;&|&&|\|\||\|&)/;
const HARMLESS_WRITE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

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

  for (let i = 0; i < text.length;) {
    const ch = text[i];

    if (ch === '\\') {
      current += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '\'') {
      const end = text.indexOf('\'', i + 1);
      if (end < 0) return fail('an unterminated single quote');
      current += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // Double quotes do not stop $(…) or backticks from running.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue; }
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
      i = j + 1;
      continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>') && text[i + 1] === '(') {
      // $(…) command substitution, <(…) and >(…) process substitution.
      const end = closingParen(text, i + 1);
      if (end < 0) return fail(`an unterminated ${ch}(`);
      addSubstitution(text.slice(i + 2, end));
      current += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = closingBacktick(text, i + 1);
      if (end < 0) return fail('an unterminated backtick');
      addSubstitution(text.slice(i + 1, end));
      current += text.slice(i, end + 1);
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
      i = k;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      endSegment();
      const operator = CONTROL_OPERATORS.exec(text.slice(i));
      i += operator ? operator[0].length : 1;
      continue;
    }
    current += ch;
    i++;
  }

  endSegment();
  return result;
}
