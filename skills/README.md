# Skills

Packaged instructions so an agent uses these tools well — the things it cannot
infer from a tool description, because they are about judgement rather than
syntax.

| Skill | When it fires |
|---|---|
| `ssh-operations` | Any task that deploys, backs up, restarts, or runs commands on a server |
| `ssh-incident` | "The server is down", "the site is slow", "something broke" |
| `ssh-restricted` | A tool was refused: security modes and human approval |

They are deliberately short. A skill that reads like a manual gets skimmed; these
say the few things that actually change what an agent does — look before you
change, back up before you overwrite, read the log before restarting, and treat
a refusal as the system working rather than an obstacle.

## Installing them

They ship with the npm package, so they are already on disk once it is installed.
Copy the ones you want into your agent's skills directory:

```bash
# Claude Code, user-wide
cp -r "$(npm root -g)/mcp-ssh-manager/skills/"* ~/.claude/skills/

# or for one project
mkdir -p .claude/skills && cp -r "$(npm root -g)/mcp-ssh-manager/skills/"* .claude/skills/
```

From a clone, `cp -r skills/* ~/.claude/skills/`.

## Writing your own

Your servers have habits these cannot know: a deploy that must run from a
particular directory, a service that has to be drained before restarting, a
database that must never be dumped during business hours. Those belong in a skill
of your own, next to these.

The format is a directory with a `SKILL.md`, front matter carrying `name` and
`description`. The description is what decides whether the skill is loaded, so
write it as the situation, not as a summary of the contents.
