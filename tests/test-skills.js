// Guards the shipped skills.
//
// A skill is prose, so nothing type-checks it and nothing runs it. Two ways it
// rots silently, both of which make it worse than having no skill at all:
//
//   1. **It names a tool that no longer exists.** An agent told to call
//      `ssh_health_check` when the tool was renamed will try, fail, and trust
//      the rest of the file less.
//   2. **It stops being loadable.** The front matter is what decides whether a
//      skill fires; a broken one is a file nobody reads.
//
// It also checks they stay short. A skill that reads like a manual gets skimmed,
// which defeats the point of writing it.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const SRC_INDEX = path.join(__dirname, '..', 'src', 'index.js');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

/** Skill directories, each of which must hold a SKILL.md. */
const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

/**
 * Minimal front-matter parse: the delimiters and the two keys that matter.
 * Deliberately not a YAML dependency — this checks a shape, not a document.
 * @param {string} content - File contents
 * @returns {{name: string|null, description: string|null, body: string}}
 */
function parseFrontMatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match) return { name: null, description: null, body: content };
  const [, front, body] = match;
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? null;
  const description = /^description:\s*(\|[\s\S]*|.+)$/m.exec(front)?.[1]?.trim() ?? null;
  return { name, description, body };
}

function testEverySkillIsLoadable() {
  assert.ok(skillDirs.length > 0, 'there must be at least one skill');

  for (const dir of skillDirs) {
    const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${dir} must contain a SKILL.md`);

    const { name, description } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
    assert.ok(name, `${dir}: front matter must declare a name`);
    assert.strictEqual(name, dir,
      `${dir}: the name must match the directory, or the skill loads under a name nobody typed`);
    assert.ok(description, `${dir}: front matter must declare a description`);
  }
  ok(`every skill has loadable front matter whose name matches its directory (${skillDirs.length} skills)`);
}

function testDescriptionsSayWhenNotWhat() {
  // The description is what decides whether a skill fires, so it has to describe
  // the situation. "Use when…" is the shape that works.
  for (const dir of skillDirs) {
    const { description } = parseFrontMatter(fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8'));
    assert.ok(/use (this )?when|use it when/i.test(description || ''),
      `${dir}: the description must say when to use the skill, not only what it contains`);
  }
  ok('every description states when the skill applies');
}

function testEveryToolNamedActuallyExists() {
  // The failure this prevents: a skill telling an agent to call a tool that was
  // renamed or removed. The agent tries it, fails, and trusts the file less.
  const registered = new Set(
    [...fs.readFileSync(SRC_INDEX, 'utf8').matchAll(/registerToolConditional\(\s*'([a-z0-9_]+)'/g)]
      .map(match => match[1])
  );
  assert.ok(registered.size > 20, `expected the tool registry to be found, got ${registered.size}`);

  const missing = [];
  for (const dir of skillDirs) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
    for (const [, tool] of content.matchAll(/`(ssh_[a-z0-9_]+)`/g)) {
      if (!registered.has(tool)) missing.push(`${dir}: ${tool}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    `skills name tools that are not registered:\n${missing.join('\n')}`);
  ok(`every ssh_* tool named in a skill is actually registered (${registered.size} tools)`);
}

function testSkillsStayShort() {
  // A skill that reads like a manual gets skimmed. This is a smell test, not a
  // style rule: the limit is generous, and crossing it means splitting up.
  for (const dir of skillDirs) {
    const words = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8').split(/\s+/).length;
    assert.ok(words < 900, `${dir}: ${words} words — split it rather than let it become a manual`);
  }
  ok('no skill has grown into a manual');
}

function testSkillsShipWithThePackage() {
  // They are useless if npm does not carry them.
  const npmignore = fs.readFileSync(path.join(__dirname, '..', '.npmignore'), 'utf8');
  const excluded = npmignore.split('\n').map(l => l.trim())
    .some(line => line === 'skills/' || line === 'skills' || line === '/skills');
  assert.ok(!excluded, '.npmignore must not exclude skills/ — they ship with the package');
  ok('skills are not excluded from the published package');
}

function main() {
  testEverySkillIsLoadable();
  testDescriptionsSayWhenNotWhat();
  testEveryToolNamedActuallyExists();
  testSkillsStayShort();
  testSkillsShipWithThePackage();
  console.log(`\n✅ skill tests passed (${passed} checks)`);
}

main();
