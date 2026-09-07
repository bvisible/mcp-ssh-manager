#!/bin/bash
# Colors and formatting library for ssh-manager CLI

# Color codes
export RED=$'\033[0;31m'
export GREEN=$'\033[0;32m'
export YELLOW=$'\033[1;33m'
export BLUE=$'\033[0;34m'
export MAGENTA=$'\033[0;35m'
export CYAN=$'\033[0;36m'
export WHITE=$'\033[1;37m'
export GRAY=$'\033[0;90m'
export BOLD=$'\033[1m'
export NC=$'\033[0m' # No Color

# Unicode symbols
export CHECK="✅"
export CROSS="❌"
export WARN="⚠️"
export INFO="ℹ️ "
export ARROW="➜"
export ROCKET="🚀"
export KEY="🔑"
export SERVER="🖥️ "
export FOLDER="📁"
export SYNC="🔄"
export MONITOR="📊"
export EYES="👀"
export TUNNEL="🔧"
export SESSION="💻"
export CLIPBOARD="📋"
export EYE="👁️"
export GEAR="⚙️ "
export PENCIL="✏️ "
export NOTE="📝"
export WRENCH="🔧"
export LOCK="🔒"
export UNLOCK="🔓"
export STAR="⭐"
export HEART="❤️"
export LIGHTBULB="💡"
export BUG="🐛"

# Print functions
print_success() {
    echo -e "${GREEN}${CHECK} $1${NC}"
}

print_error() {
    echo -e "${RED}${CROSS} $1${NC}" >&2
}

print_warning() {
    echo -e "${YELLOW}${WARN} $1${NC}"
}

print_info() {
    echo -e "${CYAN}${INFO} $1${NC}"
}

print_header() {
    echo -e "\n${BOLD}${BLUE}$1${NC}"
    echo -e "${BLUE}$(printf '%.0s=' {1..60})${NC}"
}

print_subheader() {
    echo -e "\n${BOLD}${CYAN}$1${NC}"
    echo -e "${CYAN}$(printf '%.0s-' {1..40})${NC}"
}

# Table printing with column alignment
print_table_header() {
    local col1="$1"
    local col2="$2"
    local col3="${3:-}"
    
    echo -e "${BOLD}"
    printf "%-20s %-30s %s\n" "$col1" "$col2" "$col3"
    echo -e "$(printf '%.0s-' {1..70})${NC}"
}

print_table_row() {
    local col1="$1"
    local col2="$2"
    local col3="${3:-}"
    
    printf "%-20s %-30s %s\n" "$col1" "$col2" "$col3"
}

# Progress spinner
spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='⣾⣽⣻⢿⡿⣟⣯⣷'
    
    while [ "$(ps a | awk '{print $1}' | grep $pid)" ]; do
        local temp=${spinstr#?}
        printf " [%c]  " "$spinstr"
        local spinstr=$temp${spinstr%"$temp"}
        sleep $delay
        printf "\b\b\b\b\b\b"
    done
    printf "    \b\b\b\b"
}

# Prompt functions
prompt_yes_no() {
    local prompt="$1"
    local default="${2:-n}"
    
    if [ "$default" = "y" ]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi
    
    read -p "$prompt" response
    response=${response:-$default}
    
    case "$response" in
        [yY][eE][sS]|[yY])
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"
    
    if [ -n "$default" ]; then
        read -p "$prompt [$default]: " input
        input=${input:-$default}
    else
        read -p "$prompt: " input
    fi
    
    eval "$var_name='$input'"
}

prompt_password() {
    local prompt="$1"
    local var_name="$2"
    
    echo -n "$prompt: "
    read -s password
    echo
    eval "$var_name='$password'"
}

# Status indicators
show_status() {
    local status="$1"
    case "$status" in
        "active"|"running"|"success")
            echo -e "${GREEN}● $status${NC}"
            ;;
        "inactive"|"stopped")
            echo -e "${GRAY}● $status${NC}"
            ;;
        "failed"|"error")
            echo -e "${RED}● $status${NC}"
            ;;
        "warning"|"degraded")
            echo -e "${YELLOW}● $status${NC}"
            ;;
        *)
            echo "● $status"
            ;;
    esac
}