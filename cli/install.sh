#!/bin/bash
# Installation script for SSH Manager CLI

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Installation directory
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "${BLUE}SSH Manager CLI Installation${NC}"
echo "=============================="
echo

# Check for required dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"
missing=()

for cmd in ssh; do
    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $cmd"
    else
        echo -e "  ${RED}✗${NC} $cmd (required)"
        missing+=("$cmd")
    fi
done

# rsync is only used by `ssh-manager sync`; not bundled with Git Bash on Windows.
# Treat as optional so the CLI is usable without it.
for cmd in rsync jq sshpass; do
    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $cmd"
    else
        echo -e "  ${YELLOW}⚠${NC} $cmd (optional)"
    fi
done

if [ ${#missing[@]} -gt 0 ]; then
    echo
    echo -e "${RED}Error: Missing required dependencies: ${missing[*]}${NC}"
    echo "Please install them and try again."
    exit 1
fi

# Check installation directory
echo
echo -e "${YELLOW}Installation directory:${NC} $INSTALL_DIR"

if [ ! -w "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Note: You may need sudo permissions to install to $INSTALL_DIR${NC}"
    SUDO="sudo"
else
    SUDO=""
fi

# Create symlink
echo
echo -e "${YELLOW}Installing ssh-manager...${NC}"

# Copy entire CLI directory to home
CLI_HOME="$HOME/.ssh-manager-cli"
echo "Copying CLI files to $CLI_HOME..."
rm -rf "$CLI_HOME"
cp -r "$SCRIPT_DIR" "$CLI_HOME"

# Create executable symlink
$SUDO ln -sf "$CLI_HOME/ssh-manager" "$INSTALL_DIR/ssh-manager"

# Make sure it's executable
chmod +x "$CLI_HOME/ssh-manager"

# Verify installation
if command -v ssh-manager >/dev/null 2>&1; then
    echo
    echo -e "${GREEN}✅ Installation successful!${NC}"
    echo
    echo "SSH Manager CLI has been installed to: $INSTALL_DIR/ssh-manager"
    echo
    echo "Quick start:"
    echo "  ssh-manager --help           # Show help"
    echo "  ssh-manager server add       # Add a new server"
    echo "  ssh-manager server list      # List servers"
    echo "  ssh-manager server test      # Test connection"
    echo
    echo "Configuration files:"
    echo "  ~/.ssh-manager/              # Config directory"
    echo "  .env                         # Server definitions"
else
    echo
    echo -e "${RED}❌ Installation failed${NC}"
    echo "Please check the error messages above."
    exit 1
fi

# Optional: Install shell completions
echo
read -p "Install bash completions? [y/N]: " install_completions
if [[ "$install_completions" =~ ^[yY]$ ]]; then
    # Create bash completion script
    cat > "$CLI_HOME/ssh-manager-completion.bash" <<'EOF'
# Bash completion for ssh-manager
_ssh_manager() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    
    # Main commands
    local commands="server sync tunnel monitor session exec config ssh help version"
    
    # Server subcommands
    local server_commands="add list test remove edit show"
    
    # Sync subcommands
    local sync_commands="push pull"
    
    # Tunnel subcommands  
    local tunnel_commands="create list"
    
    case "${COMP_CWORD}" in
        1)
            COMPREPLY=( $(compgen -W "${commands}" -- ${cur}) )
            ;;
        2)
            case "${prev}" in
                server)
                    COMPREPLY=( $(compgen -W "${server_commands}" -- ${cur}) )
                    ;;
                sync)
                    COMPREPLY=( $(compgen -W "${sync_commands}" -- ${cur}) )
                    ;;
                tunnel)
                    COMPREPLY=( $(compgen -W "${tunnel_commands}" -- ${cur}) )
                    ;;
            esac
            ;;
    esac
    
    return 0
}

complete -F _ssh_manager ssh-manager
EOF
    
    # Install to bash completion directory
    if [ -d "/usr/local/etc/bash_completion.d" ]; then
        $SUDO cp "$CLI_HOME/ssh-manager-completion.bash" "/usr/local/etc/bash_completion.d/"
        echo -e "${GREEN}✓ Bash completions installed${NC}"
    elif [ -d "/etc/bash_completion.d" ]; then
        $SUDO cp "$CLI_HOME/ssh-manager-completion.bash" "/etc/bash_completion.d/"
        echo -e "${GREEN}✓ Bash completions installed${NC}"
    else
        echo -e "${YELLOW}⚠ Could not find bash completion directory${NC}"
        echo "Add this to your ~/.bashrc:"
        echo "  source $CLI_HOME/ssh-manager-completion.bash"
    fi
fi

echo
echo -e "${GREEN}Installation complete! 🎉${NC}"