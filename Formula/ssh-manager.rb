# Homebrew formula for MCP SSH Manager.
#
# Installs the same npm package, so `brew install` and `npm install -g` give
# identical binaries — the vault, the approval broker and the control plane are
# all in the engine, not in a separate desktop build.
#
# Kept in this repository rather than a separate tap so it is updated in the same
# commit as the release that changes it. Install with:
#
#   brew install bvisible/mcp-ssh-manager/ssh-manager
#
# after `brew tap bvisible/mcp-ssh-manager https://github.com/bvisible/mcp-ssh-manager`.
class SshManager < Formula
  desc "SSH server management for AI agents, with approval and audit"
  homepage "https://github.com/bvisible/mcp-ssh-manager"
  url "https://registry.npmjs.org/mcp-ssh-manager/-/mcp-ssh-manager-3.8.5.tgz"
  sha256 "494293e55b071a1d908b8af037a3a77094d6bb20dbe3ad25c2671ace8234b038"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Two commands are installed:

        ssh-manager        manage servers, the encrypted vault, and the control plane
        mcp-ssh-manager    the MCP server itself, started by your agent

      Register it with Claude Code:

        claude mcp add ssh-manager mcp-ssh-manager

      Then, to keep credentials out of a clear-text .env:

        ssh-manager vault import

      To review and approve what your agents do before it runs:

        ssh-manager control
    EOS
  end

  test do
    # The CLI must run without a config, and the MCP server must complete a real
    # stdio handshake — a formula that only checks `--version` proves nothing
    # about whether the package actually works.
    assert_match "ssh-manager", shell_output("#{bin}/ssh-manager --help 2>&1")

    handshake = <<~JSON
      {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"brew-test","version":"1"}}}
    JSON
    output = pipe_output("#{bin}/mcp-ssh-manager 2>/dev/null", handshake, 0)
    assert_match "mcp-ssh-manager", output
  end
end
