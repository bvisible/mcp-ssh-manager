# Upgrading from 3.8 to 4.0

**Short version: you do not have to do anything.** Update, and everything keeps
working exactly as it did. The rest of this page is about a thing you may
*choose* to do afterwards.

```bash
npm update -g mcp-ssh-manager
```

Your `.env`, your TOML file, your environment variables, your security modes,
your groups — all read the same way, in the same order of precedence. There is
no migration step, no prompt on first run, and no file created anywhere until
you ask for one. This is enforced by `npm run test:upgrade`, which loads a
3.8-era `.env` and asserts the result is unchanged.

## What is new, and optional

An **encrypted vault**. Instead of credentials sitting in clear text in a
`.env`, secrets are stored with AES-256-GCM under a key held in your OS
keychain. Hosts, ports, users and modes stay readable, so the file can still be
inspected and diffed — only the secrets are opaque.

The vault sits **above** your files, not in place of them:

```
process environment          ← still wins over everything
  └── vault                  ← wins for servers it holds
        └── .env / TOML      ← everything else, exactly as before
```

A server in the vault is served from the vault. A server only in your `.env` is
served from your `.env`. Both at once is a normal state, not a broken one — you
can move servers over one at a time, or never.

## Moving a server into the vault

Either from the interface — `ssh-manager control` shows a banner naming the file
and the servers still in it — or from the command line:

```bash
ssh-manager vault import          # reads your .env, encrypts, writes the vault
```

**Your `.env` is not modified.** Not by `import`, not by the interface, not
ever. Removing secrets from it is a separate decision, and one to make only
after the next section.

## Before you delete anything: the key does not travel

The vault's key lives in **this machine's** keychain. It is not in the vault
file, and it does not follow the vault to a backup, a sync folder or a new
laptop. Copy the vault to another machine and it is a file of ciphertext nobody
can open.

That is the right trade for a key — but it means that the moment your vault is
the *only* copy of a credential, one wiped keyring stands between you and a
locked-out afternoon.

So, in this order:

```bash
# 1. A copy that does not depend on this machine
ssh-manager vault backup ~/ssh-manager-recovery.json

# 2. Confirm this machine can actually decrypt what it wrote
ssh-manager vault status        # look for: Readable   yes

# 3. Run something real against a server

# 4. Only now, if you want to, remove the secrets from your .env
```

The recovery file is encrypted with a **passphrase you choose**, not with the
machine key. Keep it where you keep passwords — a password manager will hold it
as an attachment. Unlike the vault, it reveals nothing at all without the
passphrase, not even a hostname, because it is meant to be stored somewhere less
trusted.

There is no way to recover that passphrase. If you lose it, the file is noise.

## On a new machine

```bash
ssh-manager vault restore ~/ssh-manager-recovery.json
```

It asks for the passphrase, tells you what the file holds before you type
anything, and warns before replacing a server that already exists.

## If the key is already gone

You will be told, plainly, rather than left to find out from a failed deploy:

```
This vault cannot be read on this machine.

The vault at ~/.ssh-manager/vault.json is encrypted with a key this machine no
longer has. A new key was generated, which cannot read it. Nothing has been
overwritten.
```

Three ways out, in order of preference:

1. **A recovery file** — `ssh-manager vault restore <file>`.
2. **The servers are still in a `.env`** — delete the vault and run
   `ssh-manager vault import` again. This is why keeping the `.env` for a while
   is a reasonable thing to do.
3. **Neither** — the secrets in that vault are unrecoverable. Move the file
   aside and re-add the servers. The hosts, ports and users are still readable
   in it, so you are re-entering passwords, not rebuilding an inventory.

## Where things live

| | Path | Contains |
|---|---|---|
| Vault | `~/.ssh-manager/vault.json` | servers; secrets encrypted |
| Key | OS keychain, or `~/.ssh-manager/vault.key` (0600) | the master key |
| Recovery file | wherever you put it | everything, under your passphrase |

`SSH_MANAGER_KEY_SOURCE=file` skips the keychain entirely — needed in CI, in
containers, and over an SSH session with no desktop keyring.

## Staying on `.env` forever

Entirely supported, and not a second-class path. `npm install mcp-ssh-manager`
with no vault, no `APPROVAL` setting and no control plane running behaves
exactly like 3.8. The control plane is a separate command you run when you want
it; the engine never starts one.
