# Contributing to MCP SSH Manager

First off, thank you for considering contributing to MCP SSH Manager! It's people like you that make this tool better for everyone.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples**
- **Describe the behavior you observed and expected**
- **Include logs and error messages**
- **Include your environment details** (OS, Node.js version, Python version)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested enhancement**
- **Provide specific examples to demonstrate the enhancement**
- **Describe the current behavior and expected behavior**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes
4. Make sure your code follows the existing code style
5. Write a clear commit message
6. Commit `package-lock.json` if you touched dependencies

## Development Process

1. Clone your fork:
   ```bash
   git clone https://github.com/your-username/mcp-ssh-manager.git
   cd mcp-ssh-manager
   ```

2. Install dependencies:
   ```bash
   npm ci                                # exact versions from package-lock.json
   pip install -r tools/requirements.txt
   ```

   `package-lock.json` is committed. Use `npm ci` to install: it reproduces the
   exact tree CI uses and fails loudly if the lockfile and `package.json` have
   drifted apart. If you add, remove or bump a dependency, commit the updated
   lockfile alongside `package.json` — `npm run test:lockfile` checks the two
   stay in sync.

   The lockfile was generated with npm 11. Older npm reformats it (key order,
   the `libc` field) and produces a huge diff even when no version changes —
   if your diff is thousands of lines but `npm run test:lockfile` still passes,
   that is what happened; drop the reformat and keep only real version changes.

3. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. Make your changes and test them

   The interface (`ui/`) is built, not committed: `npm run build:ui` builds it
   into the git-ignored `dist/ui`, which `ssh-manager control` serves from a
   checkout. Changing `ui/` needs no build artifact in your pull request.

5. Commit your changes:
   ```bash
   git add .
   git commit -m "Add your descriptive commit message"
   ```

6. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

7. Open a Pull Request

## Style Guidelines

### JavaScript Style
- Use ES6+ features
- Use async/await for asynchronous code
- Add JSDoc comments for functions
- Use meaningful variable names

### Python Style
- Follow PEP 8
- Use type hints where appropriate
- Add docstrings to functions and classes
- Use meaningful variable names

### Commit Messages
- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line

## Testing

Before submitting a pull request:

1. Run `npm run test:all` (test suite + typecheck + validation script)
2. Test your changes manually
3. Ensure existing functionality still works
4. Test with different server configurations
5. Verify Claude Code integration works

CI installs with `npm ci` on Node 18, 20 and 22, and the `lint` job runs
ESLint and the JSDoc typecheck as blocking gates.

### Tests come with the change

New functionality and every bug fix arrive with automated tests, in the same
pull request: a test that fails without the change and passes with it. This is
the project's policy for any major new functionality, and reviewers ask for the
test before the code. Where the test is:

- `tests/test-*.js` for the engine (run by `npm test`; each file is also a
  script of its own, `npm run test:<name>`),
- `ui/tests/*.spec.ts` for the interface (Playwright, `npm --prefix ui run
  test:e2e`),
- `tests/test-shell-quote-properties.js` shows the property-based style
  (`fast-check`) used where a bug class matters more than one example: anything
  that builds a command for a remote shell must go through `shellQuote()` and be
  covered by it.

Security fixes also add the exact input that broke the code as a regression
test (see `tests/test-backup-monitor-injection.js` for the pattern).

### Static analysis and warnings

ESLint, the JSDoc typecheck (`npm run typecheck`, zero errors) and CodeQL run on
every push and pull request, and OpenSSF Scorecard runs on `main`. Findings are
fixed rather than ignored; an alert that is a false positive is dismissed on
GitHub with a written reason.

## Documentation

- Update README.md if you change functionality
- Add JSDoc/docstrings for new functions
- Update examples if needed
- Keep documentation clear and concise

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🎉