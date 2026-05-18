#!/bin/bash
# Configuration management library for ssh-manager CLI

# Configuration paths
export SSH_MANAGER_HOME="${SSH_MANAGER_HOME:-$HOME/.ssh-manager}"
export SSH_MANAGER_CONFIG="$SSH_MANAGER_HOME/config.json"

# Resolve .env path with fallback chain (consistent with src/index.js):
# 1. SSH_MANAGER_ENV env var (explicit override)
# 2. ~/.ssh-manager/.env (user config directory — preferred for global installs)
# 3. $PWD/.env (current working directory)
# 4. ~/.env (home directory)
# 5. <project-root>/.env (backward compat for local/dev installs)
if [ -z "$SSH_MANAGER_ENV" ]; then
    if [ -f "$SSH_MANAGER_HOME/.env" ]; then
        SSH_MANAGER_ENV="$SSH_MANAGER_HOME/.env"
    elif [ -f "$PWD/.env" ]; then
        SSH_MANAGER_ENV="$PWD/.env"
    elif [ -f "$HOME/.env" ]; then
        SSH_MANAGER_ENV="$HOME/.env"
    else
        # Resolve project root from script location (works for local installs)
        if [ -n "$SCRIPT_DIR" ]; then
            _PROJECT_ENV="$(dirname "$SCRIPT_DIR")/.env"
        else
            if [ -L "$0" ]; then
                _REAL_PATH="$(readlink -f "$0" 2>/dev/null || readlink "$0")"
            else
                _REAL_PATH="$0"
            fi
            _REAL_DIR="$(cd "$(dirname "$_REAL_PATH")" && pwd)"
            _PROJECT_ENV="$(dirname "$(dirname "$_REAL_DIR")")/.env"
        fi
        if [ -f "$_PROJECT_ENV" ]; then
            SSH_MANAGER_ENV="$_PROJECT_ENV"
        else
            # Default to user config directory (will be created on first server add)
            SSH_MANAGER_ENV="$SSH_MANAGER_HOME/.env"
        fi
        unset _PROJECT_ENV _REAL_PATH _REAL_DIR
    fi
    export SSH_MANAGER_ENV
fi

export SSH_MANAGER_ALIASES="$SSH_MANAGER_HOME/aliases.json"

# Ensure config directory exists
init_config() {
    if [ ! -d "$SSH_MANAGER_HOME" ]; then
        mkdir -p "$SSH_MANAGER_HOME"
        print_info "Created config directory: $SSH_MANAGER_HOME"
    fi
    
    # Create default config if not exists
    if [ ! -f "$SSH_MANAGER_CONFIG" ]; then
        cat > "$SSH_MANAGER_CONFIG" <<EOF
{
  "default_editor": "${EDITOR:-nano}",
  "default_shell": "${SHELL:-/bin/bash}",
  "history_file": "$SSH_MANAGER_HOME/history",
  "log_level": "info",
  "color_output": true
}
EOF
        print_info "Created default config: $SSH_MANAGER_CONFIG"
    fi
}

# Load configuration value
get_config() {
    local key="$1"
    local default="$2"
    
    if [ -f "$SSH_MANAGER_CONFIG" ] && command -v jq >/dev/null 2>&1; then
        local value=$(jq -r ".$key // null" "$SSH_MANAGER_CONFIG" 2>/dev/null)
        if [ "$value" != "null" ]; then
            echo "$value"
        else
            echo "$default"
        fi
    else
        echo "$default"
    fi
}

# Set configuration value
set_config() {
    local key="$1"
    local value="$2"
    
    if command -v jq >/dev/null 2>&1; then
        local temp=$(mktemp)
        jq ".$key = \"$value\"" "$SSH_MANAGER_CONFIG" > "$temp" && mv "$temp" "$SSH_MANAGER_CONFIG"
        print_success "Updated config: $key = $value"
    else
        print_error "jq is required for config management"
        return 1
    fi
}

# Load servers from .env file
load_servers() {
    local servers=()
    
    if [ ! -f "$SSH_MANAGER_ENV" ]; then
        return 1
    fi
    
    # Parse .env file for server definitions
    while IFS= read -r line; do
        if [[ "$line" =~ ^SSH_SERVER_(.+)_HOST= ]]; then
            local server_name="${BASH_REMATCH[1]}"
            # Convert to lowercase
            server_name=$(echo "$server_name" | tr '[:upper:]' '[:lower:]')
            servers+=("$server_name")
        fi
    done < "$SSH_MANAGER_ENV"
    
    # Remove duplicates
    printf '%s\n' "${servers[@]}" | sort -u
}

# Get server configuration
get_server_config() {
    local server="$1"
    local field="$2"
    local server_upper="$(echo "$server" | tr '[:lower:]' '[:upper:]')"

    if [ ! -f "$SSH_MANAGER_ENV" ]; then
        return 1
    fi

    local field_upper="$(echo "$field" | tr '[:lower:]' '[:upper:]')"
    local key="SSH_SERVER_${server_upper}_${field_upper}"

    # Read value using IFS to preserve all special characters including quotes
    local value=""
    while IFS="=" read -r k v; do
        if [[ "$k" == "$key" ]]; then
            value="$v"
            break
        fi
    done < <(grep "^${key}=" "$SSH_MANAGER_ENV" 2>/dev/null)

    # Return error if no value found
    if [ -z "$value" ]; then
        return 1
    fi

    # Only remove surrounding quotes if they exist, preserve quotes within the value
    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    else
        printf '%s' "$value"
    fi
}

# Add server to .env
#
# Trailing security-mode args (8-10) are optional and default to "" — when
# omitted they are not written, preserving exact pre-v3.5.0 output for existing
# wizard call sites.
add_server_to_env() {
    local name="$1"
    local host="$2"
    local user="$3"
    local auth_type="$4"
    local auth_value="$5"
    local port="${6:-22}"
    local description="${7:-}"
    local mode="${8:-}"
    local allow_patterns="${9:-}"
    local audit_log="${10:-}"

    local name_upper="$(echo "$name" | tr '[:lower:]' '[:upper:]')"

    # Check if server already exists
    if grep -q "^SSH_SERVER_${name_upper}_HOST=" "$SSH_MANAGER_ENV" 2>/dev/null; then
        print_error "Server '$name' already exists"
        return 1
    fi

    # Ensure parent directory and .env file exist
    mkdir -p "$(dirname "$SSH_MANAGER_ENV")"
    touch "$SSH_MANAGER_ENV"

    # Backup .env file
    cp "$SSH_MANAGER_ENV" "$SSH_MANAGER_ENV.bak"

    # Add server configuration
    {
        echo ""
        echo "# Server: $name"
        echo "SSH_SERVER_${name_upper}_HOST=$host"
        echo "SSH_SERVER_${name_upper}_USER=$user"
        echo "SSH_SERVER_${name_upper}_PORT=$port"

        if [ "$auth_type" = "password" ]; then
            echo "SSH_SERVER_${name_upper}_PASSWORD=$auth_value"
        else
            echo "SSH_SERVER_${name_upper}_KEYPATH=$auth_value"
        fi

        if [ -n "$description" ]; then
            echo "SSH_SERVER_${name_upper}_DESCRIPTION=\"$description\""
        fi

        # Security mode (v3.5.0+) — only emit non-empty / non-default values to
        # keep generated .env diff-free for users who skip these prompts.
        if [ -n "$mode" ] && [ "$mode" != "unrestricted" ]; then
            echo "SSH_SERVER_${name_upper}_MODE=$mode"
        fi
        if [ -n "$allow_patterns" ]; then
            echo "SSH_SERVER_${name_upper}_ALLOW_PATTERNS=\"$allow_patterns\""
        fi
        if [ -n "$audit_log" ]; then
            echo "SSH_SERVER_${name_upper}_AUDIT_LOG=$audit_log"
        fi
    } >> "$SSH_MANAGER_ENV"

    print_success "Server '$name' added successfully"
}

# Update server in .env
update_server_in_env() {
    local name="$1"
    local host="$2"
    local user="$3"
    local auth_type="$4"
    local auth_value="$5"
    local port="${6:-22}"
    local description="${7:-}"
    local default_dir="${8:-}"

    local name_upper="$(echo "$name" | tr '[:lower:]' '[:upper:]')"

    # Check if server exists
    if ! grep -q "^SSH_SERVER_${name_upper}_HOST=" "$SSH_MANAGER_ENV" 2>/dev/null; then
        print_error "Server '$name' not found"
        return 1
    fi

    # Backup .env file
    cp "$SSH_MANAGER_ENV" "$SSH_MANAGER_ENV.bak"

    # Remove old server configuration (all lines including comments and old auth methods)
    local temp=$(mktemp)
    # Remove server config lines and the comment line before them
    sed "/^# Server: $name$/d; /^SSH_SERVER_${name_upper}_/d" "$SSH_MANAGER_ENV" > "$temp"

    # Find position to insert (after other servers or at end)
    # Add updated server configuration
    {
        cat "$temp"
        echo ""
        echo "# Server: $name"
        echo "SSH_SERVER_${name_upper}_HOST=$host"
        echo "SSH_SERVER_${name_upper}_USER=$user"
        echo "SSH_SERVER_${name_upper}_PORT=$port"

        if [ "$auth_type" = "password" ]; then
            echo "SSH_SERVER_${name_upper}_PASSWORD=$auth_value"
        else
            echo "SSH_SERVER_${name_upper}_KEYPATH=$auth_value"
        fi

        if [ -n "$description" ]; then
            echo "SSH_SERVER_${name_upper}_DESCRIPTION=\"$description\""
        fi

        if [ -n "$default_dir" ]; then
            echo "SSH_SERVER_${name_upper}_DEFAULT_DIR=$default_dir"
        fi
    } > "$SSH_MANAGER_ENV"

    rm -f "$temp"
    print_success "Server '$name' updated successfully"
}

# Remove server from .env
remove_server_from_env() {
    local name="$1"
    local name_upper="$(echo "$name" | tr '[:lower:]' '[:upper:]')"
    
    if ! grep -q "^SSH_SERVER_${name_upper}_HOST=" "$SSH_MANAGER_ENV" 2>/dev/null; then
        print_error "Server '$name' not found"
        return 1
    fi
    
    # Backup .env file
    cp "$SSH_MANAGER_ENV" "$SSH_MANAGER_ENV.bak"
    
    # Remove all lines for this server
    local temp=$(mktemp)
    grep -v "^SSH_SERVER_${name_upper}_" "$SSH_MANAGER_ENV" > "$temp"
    mv "$temp" "$SSH_MANAGER_ENV"
    
    print_success "Server '$name' removed successfully"
}

# Test SSH connection
test_ssh_connection() {
    local server="$1"
    local host=$(get_server_config "$server" "HOST")
    local user=$(get_server_config "$server" "USER")
    local port=$(get_server_config "$server" "PORT")
    local keypath=$(get_server_config "$server" "KEYPATH")
    local password=$(get_server_config "$server" "PASSWORD")

    port=${port:-22}

    if [ -z "$host" ] || [ -z "$user" ]; then
        print_error "Server '$server' not found or incomplete configuration"
        return 1
    fi

    print_info "Testing connection to $server ($user@$host:$port)..."

    local ssh_opts="-o ConnectTimeout=10 -o StrictHostKeyChecking=no"
    local ssh_output=$(mktemp)
    local ssh_status

    if [ -n "$keypath" ]; then
        ssh_opts="$ssh_opts -i $keypath"
    fi

    if [ -n "$password" ]; then
        # Use sshpass if available
        if command -v sshpass >/dev/null 2>&1; then
            sshpass -p "$password" ssh $ssh_opts -p "$port" "$user@$host" "echo 'Connection successful'" > "$ssh_output" 2>&1
            ssh_status=$?
        else
            print_warning "sshpass not installed, cannot test password authentication"
            rm -f "$ssh_output"
            return 1
        fi
    else
        ssh $ssh_opts -p "$port" "$user@$host" "echo 'Connection successful'" > "$ssh_output" 2>&1
        ssh_status=$?
    fi

    if [ $ssh_status -eq 0 ]; then
        print_success "Connection successful"
        rm -f "$ssh_output"
        return 0
    else
        print_error "Connection failed"
        # Show error details if SSH_MANAGER_DEBUG is set
        if [ -n "$SSH_MANAGER_DEBUG" ]; then
            print_warning "Debug output:"
            cat "$ssh_output" | sed 's/^/  /'
        else
            print_info "Set SSH_MANAGER_DEBUG=1 to see detailed error output"
        fi
        rm -f "$ssh_output"
        return 1
    fi
}

# Validate server name
#
# Server names are baked into POSIX environment variable names of the form
# SSH_SERVER_<NAME>_HOST. POSIX env-var names are restricted to letters,
# digits and underscore — hyphens are NOT valid (issue #25). Allowing them
# silently produced keys like SSH_SERVER_WEB-SERVER_HOST that the Bash CLI
# happily wrote and re-read, but the MCP Node loader (which uses a strict
# /^SSH_SERVER_([A-Z0-9_]+)_HOST$/ regex) silently dropped — so the server
# appeared in `ssh-manager server list` but Claude Code saw zero servers.
#
# We now reject hyphens at the source. If a user pasted in a name with a
# hyphen, we suggest the underscore equivalent in the error message so the
# fix is one keystroke away.
validate_server_name() {
    local name="$1"

    # Check if name is empty
    if [ -z "$name" ]; then
        print_error "Server name cannot be empty"
        return 1
    fi

    # Reject hyphens with a targeted message and a copy-paste suggestion.
    if [[ "$name" == *-* ]]; then
        local suggested="${name//-/_}"
        print_error "Server name cannot contain '-' (POSIX env var names allow only letters, digits, underscore)"
        print_info "Try '$suggested' instead"
        return 1
    fi

    # Catch any other invalid characters
    if ! [[ "$name" =~ ^[a-zA-Z0-9_]+$ ]]; then
        print_error "Server name can only contain letters, digits and underscore"
        return 1
    fi

    # Check if name starts with a letter
    if ! [[ "$name" =~ ^[a-zA-Z] ]]; then
        print_error "Server name must start with a letter"
        return 1
    fi

    return 0
}

# Detect server entries in .env whose names contain characters that are
# silently dropped by the MCP Node loader. Used by `server list` to flag
# legacy entries created before the validation fix in #25.
# Echoes one invalid name per line.
list_invalid_server_names() {
    if [ ! -f "$SSH_MANAGER_ENV" ]; then
        return 0
    fi
    while IFS= read -r line; do
        if [[ "$line" =~ ^SSH_SERVER_(.+)_HOST= ]]; then
            local raw="${BASH_REMATCH[1]}"
            if ! [[ "$raw" =~ ^[A-Za-z0-9_]+$ ]]; then
                # Lowercase, matching load_servers' output convention
                printf '%s\n' "$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
            fi
        fi
    done < "$SSH_MANAGER_ENV" | sort -u
}

# Check dependencies
# Only `ssh` is strictly required for the CLI to start.
# rsync is only needed by `ssh-manager sync`; on Windows + Git Bash it is not
# bundled by default, so requiring it here would block every other command
# (server add/list/test, exec, ssh, tunnel...). It is checked lazily by
# `cmd_sync` instead.
check_dependencies() {
    local missing=()

    # Check for required commands
    for cmd in ssh; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done

    # Check for optional but recommended commands
    local optional=()
    for cmd in rsync jq sshpass; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            optional+=("$cmd")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        print_error "Missing required dependencies: ${missing[*]}"
        print_info "Please install them and try again"
        return 1
    fi

    if [ ${#optional[@]} -gt 0 ]; then
        print_warning "Missing optional dependencies: ${optional[*]}"
        print_info "Some features may not work without them (rsync is needed for 'ssh-manager sync')"
    fi

    return 0
}

# Ensure a specific command is available; print an actionable error if not.
# Used by commands with feature-specific dependencies (e.g. cmd_sync needs rsync).
require_command() {
    local cmd="$1"
    local feature="${2:-this command}"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        print_error "'$cmd' is required for $feature but was not found on PATH"
        case "$cmd" in
            rsync)
                print_info "Install rsync:"
                print_info "  • macOS:   brew install rsync"
                print_info "  • Debian:  sudo apt-get install rsync"
                print_info "  • Windows: install via MSYS2/Cygwin, or use WSL"
                ;;
        esac
        return 1
    fi
    return 0
}