#!/bin/bash
# Interactive menu library for ssh-manager CLI

# --- the home screen ---------------------------------------------------------
# Where things stand, then every action one key away, in the desktop app's
# orange and without emoji. The numbers keep the meaning they have had since
# 3.1 (0 still quits and 8 still opens the help, though the screen shows q and
# ?); the letters are new.

# The desktop app's state, from `ssh-manager app --status`. Read when the menu
# opens and after the app key, not on every redraw; nothing when it cannot be.
refresh_desktop_status() {
    MENU_DESKTOP_STATUS=""
    if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$SCRIPT_DIR/app.js" ] && command -v node >/dev/null 2>&1; then
        MENU_DESKTOP_STATUS="$(node "$SCRIPT_DIR/app.js" --status 2>/dev/null || true)"
    fi
}

# "63 servers · ~/.ssh-manager/.env · desktop app 4.0.0 installed", wrapped
# between parts to fit $1 columns. Each part is left out rather than slowing
# or breaking the menu.
menu_status_line() {
    local width="${1:-80}" parts=() count line="" part tilde='~'
    if [ -f "$SSH_MANAGER_ENV" ]; then
        count="$(load_servers 2>/dev/null | grep -c . || true)"
        if [ "${count:-0}" = "1" ]; then parts+=("1 server"); else parts+=("${count:-0} servers"); fi
        parts+=("${SSH_MANAGER_ENV/#"$HOME"/$tilde}")
    else
        parts+=("no servers yet")
    fi
    if [ -n "${MENU_DESKTOP_STATUS:-}" ]; then parts+=("$MENU_DESKTOP_STATUS"); fi
    for part in "${parts[@]}"; do
        if [ -n "$line" ] && [ $(( ${#line} + 3 + ${#part} )) -gt "$width" ]; then
            printf '%s\n' "$line"
            line="$part"
        else
            line="${line:+$line · }$part"
        fi
    done
    printf '%s' "$line"
}

# One cell of the home screen: "#TITLE" a heading, "k|Label" a key, "@" the
# help and quit pair, "" nothing. $2, when given, pads it to that width.
menu_cell() {
    local cell="$1" width="${2:-0}" plain="" text=""
    case "$cell" in
        '#'*) plain="${cell#\#}"; text="${ACCENT}${BOLD}${plain}${NC}" ;;
        '@') plain="?  Help        q  Quit"; text="${ACCENT}${BOLD}?${NC}  Help        ${ACCENT}${BOLD}q${NC}  Quit" ;;
        ?'|'*) plain="${cell%%|*}  ${cell#*|}"; text="${ACCENT}${BOLD}${cell%%|*}${NC}  ${cell#*|}" ;;
    esac
    printf '%s' "$text"
    if [ "$width" -gt "${#plain}" ]; then printf '%*s' "$((width - ${#plain}))" ''; fi
}

# Display main menu
show_main_menu() {
    # Kept once: the invitation printed just before would otherwise vanish.
    if [ -n "${SSH_MANAGER_KEEP_SCREEN:-}" ]; then
        unset SSH_MANAGER_KEEP_SCREEN
    else
        clear
    fi
    local cols="${COLUMNS:-}" status line cell i
    [ -n "$cols" ] || cols="$(tput cols 2>/dev/null || true)"
    [[ "$cols" =~ ^[0-9]+$ ]] || cols=80
    status="$(menu_status_line "$((cols - 2))")"

    echo
    echo "  ${ACCENT}${BOLD}▲ SSH Manager ${VERSION}${NC}"
    while IFS= read -r line; do
        if [ -n "$line" ]; then echo "  ${GRAY}${line}${NC}"; fi
    done <<< "$status"
    echo

    local left=("#SERVERS" "1|List, test, add, edit" "2|Connect (SSH session)" "6|Run a command" "5|Health" ""
        "#SETTINGS" "7|Configuration" "t|MCP tools" "v|Encrypted vault" "i|Import servers")
    local right=("#FILES" "3|Sync (rsync)" "4|Tunnels" "" "#AGENTS" "9|Watch what they run"
        "a|Desktop app (open / install)" "" "" "" "@")
    if [ "$cols" -ge 72 ]; then
        for i in "${!left[@]}"; do
            printf '  '
            if [ -n "${right[$i]}" ]; then
                menu_cell "${left[$i]}" 33
                menu_cell "${right[$i]}"
            else
                menu_cell "${left[$i]}"
            fi
            echo
        done
    else
        for cell in "${left[@]:0:6}" "${right[@]:0:4}" "${right[@]:4:3}" "" "${left[@]:6}" "" "@"; do
            if [ -n "$cell" ]; then printf '  '; menu_cell "$cell"; fi
            echo
        done
    fi
    echo
    printf '  %s›%s ' "$ACCENT" "$NC"
}

# A sub-menu's heading, in the home screen's palette.
print_menu_header() {
    echo
    echo "  ${ACCENT}${BOLD}▲ SSH Manager${NC} ${GRAY}›${NC} ${BOLD}$1${NC}"
    echo
}

# One sub-menu entry: its key, its label, and a dimmed line under it.
menu_item() {
    echo "  ${ACCENT}${BOLD}$1${NC}  $2"
    if [ -n "${3:-}" ]; then echo "     ${GRAY}$3${NC}"; fi
}

# A sub-menu's prompt, after its entries.
menu_prompt() {
    echo
    printf '  %s›%s %s ' "$ACCENT" "$NC" "$1"
}

# Server management submenu
show_server_menu() {
    clear
    print_menu_header "Servers"
    menu_item 1 "Add New Server" "Configure a new SSH server"
    menu_item 2 "List All Servers" "Show configured servers"
    menu_item 3 "Test Connection" "Test server connectivity"
    menu_item 4 "Show Server Details" "Display server configuration"
    menu_item 5 "Edit Server" "Modify server settings"
    menu_item 6 "Remove Server" "Delete server configuration"
    menu_item 7 "Edit Config File" "Directly edit .env file"
    menu_item 0 "Back to the home screen"
    menu_prompt "Choose an option [0-7]:"
}

# Enhanced server add wizard
wizard_add_server() {
    clear
    print_header "Add New SSH Server - Setup Wizard"
    echo
    print_info "This wizard will guide you through adding a new SSH server."
    print_info "Press Ctrl+C at any time to cancel."
    echo
    
    # Step 1: Server name
    print_subheader "Step 1: Server Identification"
    echo "Choose a short, memorable name for this server."
    echo "Letters, digits and underscore only — no hyphens (POSIX env var rule)."
    echo "Examples: prod1, web_server, database, staging"
    echo
    
    local server_name
    while true; do
        prompt_input "Server name" "" "server_name"
        if validate_server_name "$server_name"; then
            # Check if already exists
            if get_server_config "$server_name" "HOST" >/dev/null 2>&1; then
                print_error "Server '$server_name' already exists!"
                if prompt_yes_no "Choose a different name?" "y"; then
                    continue
                else
                    return 1
                fi
            fi
            break
        fi
    done
    
    # Step 2: Connection details
    echo
    print_subheader "Step 2: Connection Details"
    
    local host
    echo "Enter the server's hostname or IP address."
    echo "Examples: 192.168.1.100, example.com, server.local"
    prompt_input "Host/IP" "" "host"
    
    local user
    echo
    echo "Enter the username for SSH connection."
    echo "Common choices: root, ubuntu, admin, deploy"
    prompt_input "Username" "${USER}" "user"
    
    local port
    echo
    echo "Enter the SSH port (standard is 22)."
    prompt_input "SSH Port" "22" "port"
    
    # Step 3: Authentication
    echo
    print_subheader "Step 3: Authentication Method"
    echo "How do you want to authenticate?"
    echo
    echo -e "  ${CYAN}1)${NC} ${KEY} SSH Key (Recommended)"
    echo "     More secure, no password needed"
    echo
    echo -e "  ${CYAN}2)${NC} ${LOCK} Password"
    echo "     Less secure, password required each time"
    echo
    read -p "Choose [1-2]: " auth_choice
    
    local auth_type auth_value
    case "$auth_choice" in
        2)
            auth_type="password"
            echo
            print_warning "Password authentication is less secure than SSH keys."
            prompt_password "Enter password" "auth_value"
            ;;
        *)
            auth_type="key"
            echo
            echo "Enter the path to your SSH private key."
            echo "Common locations:"
            echo "  • ~/.ssh/id_rsa (default RSA key)"
            echo "  • ~/.ssh/id_ed25519 (modern ED25519 key)"
            echo "  • ~/.ssh/custom_key (custom key)"
            prompt_input "SSH key path" "$HOME/.ssh/id_rsa" "auth_value"
            auth_value="${auth_value/#\~/$HOME}"
            
            # Check if key exists
            if [ ! -f "$auth_value" ]; then
                print_warning "Key file not found: $auth_value"
                if ! prompt_yes_no "Continue anyway?" "n"; then
                    return 1
                fi
            fi
            ;;
    esac
    
    # Step 4: Optional settings
    echo
    print_subheader "Step 4: Optional Settings"
    
    local description
    echo "Add a description to help identify this server (optional)."
    echo "Example: Production web server, Database backup, Test environment"
    prompt_input "Description" "" "description"
    
    local default_dir
    echo
    echo "Set a default directory for this server (optional)."
    echo "Example: /var/www/html, /home/user/app, /opt/services"
    prompt_input "Default directory" "" "default_dir"

    local group
    echo
    echo "Assign this server to a group (optional)."
    echo "Servers sharing a group can be targeted together with ssh_execute_group."
    echo "Example: production, staging, customer-acme"
    prompt_input "Group" "" "group"

    local forward_agent="n"
    echo
    echo "Forward your local ssh-agent to this server (optional)."
    echo "Lets remote processes use your local keys — e.g. git over SSH."
    print_warning "Security: anyone with root on this host can use your loaded keys"
    print_warning "for the life of the connection. Only enable for servers you trust."
    if prompt_yes_no "Enable SSH agent forwarding?" "n"; then
        forward_agent="y"
    fi

    # Step 5: Review
    echo
    print_subheader "Step 5: Review Configuration"
    echo
    print_table_row "Name:" "$server_name"
    print_table_row "Host:" "$host"
    print_table_row "User:" "$user"
    print_table_row "Port:" "$port"
    print_table_row "Auth:" "$auth_type"
    if [ "$auth_type" = "key" ]; then
        print_table_row "Key:" "$auth_value"
    else
        print_table_row "Password:" "********"
    fi
    if [ -n "$description" ]; then
        print_table_row "Description:" "$description"
    fi
    if [ -n "$default_dir" ]; then
        print_table_row "Default Dir:" "$default_dir"
    fi
    if [ -n "$group" ]; then
        print_table_row "Group:" "$group"
    fi
    if [ "$forward_agent" = "y" ]; then
        print_table_row "Agent Forwarding:" "enabled"
    fi

    echo
    if prompt_yes_no "Save this configuration?" "y"; then
        # Save to .env
        add_server_to_env "$server_name" "$host" "$user" "$auth_type" "$auth_value" "$port" "$description"

        local name_upper="$(echo "$server_name" | tr '[:lower:]' '[:upper:]')"

        # Add default directory if specified
        if [ -n "$default_dir" ]; then
            echo "SSH_SERVER_${name_upper}_DEFAULT_DIR=$default_dir" >> "$SSH_MANAGER_ENV"
        fi

        # Add group if specified (quoted: free-form text, may contain spaces)
        if [ -n "$group" ]; then
            echo "SSH_SERVER_${name_upper}_GROUP=\"$group\"" >> "$SSH_MANAGER_ENV"
        fi

        # Enable agent forwarding if opted in
        if [ "$forward_agent" = "y" ]; then
            echo "SSH_SERVER_${name_upper}_FORWARD_AGENT=true" >> "$SSH_MANAGER_ENV"
        fi

        echo
        print_success "Server '$server_name' added successfully!"
        
        echo
        if prompt_yes_no "Test connection now?" "y"; then
            echo
            test_ssh_connection "$server_name"
        fi
        
        echo
        print_info "Quick commands for '$server_name':"
        echo "  • Connect: ssh-manager ssh $server_name"
        echo "  • Test:    ssh-manager server test $server_name"
        echo "  • Execute: ssh-manager exec $server_name \"command\""
        
        echo
        read -p "Press Enter to continue..."
    else
        print_info "Configuration cancelled"
    fi
}

# Edit server wizard
wizard_edit_server() {
    # Select server to edit
    if ! select_server_menu "Select Server to Edit"; then
        return 1
    fi

    local server_name="$selected_server"

    # Load existing configuration
    local current_host=$(get_server_config "$server_name" "HOST")
    local current_user=$(get_server_config "$server_name" "USER")
    local current_port=$(get_server_config "$server_name" "PORT")
    local current_keypath=$(get_server_config "$server_name" "KEYPATH")
    local current_password=$(get_server_config "$server_name" "PASSWORD")
    local current_description=$(get_server_config "$server_name" "DESCRIPTION")
    local current_default_dir=$(get_server_config "$server_name" "DEFAULT_DIR")

    current_port=${current_port:-22}

    # Determine current auth type
    local current_auth_type="key"
    if [ -n "$current_password" ]; then
        current_auth_type="password"
    fi

    clear
    print_header "Edit Server - $server_name"
    print_info "Press Enter to keep current value, or type new value"
    echo

    # Step 1: Connection Details
    print_subheader "Step 1: Connection Details"
    echo "----------------------------------------"

    local host
    prompt_input "Host/IP" "$current_host" "host"

    local user
    prompt_input "Username" "$current_user" "user"

    local port
    prompt_input "Port" "$current_port" "port"

    # Step 2: Authentication Method
    echo
    print_subheader "Step 2: Authentication Method"
    echo "----------------------------------------"
    echo "Current method: $current_auth_type"
    echo
    echo "  1) 🔑 SSH Key (Recommended)"
    echo "     More secure, no password needed"
    echo
    echo "  2) 🔒 Password"
    echo "     Less secure, password required each time"
    echo
    read -p "Choose [1-2] or Enter to keep current: " auth_choice

    local auth_type auth_value
    if [ -z "$auth_choice" ]; then
        # Keep current auth method
        auth_type="$current_auth_type"
        if [ "$auth_type" = "password" ]; then
            auth_value="$current_password"
        else
            auth_value="$current_keypath"
        fi
    else
        case "$auth_choice" in
            2)
                auth_type="password"
                prompt_password "Password" "auth_value"
                ;;
            *)
                auth_type="key"
                prompt_input "SSH key path" "${current_keypath:-$HOME/.ssh/id_rsa}" "auth_value"
                # Expand ~ to home directory
                auth_value="${auth_value/#\~/$HOME}"
                ;;
        esac
    fi

    # Step 3: Optional Settings
    echo
    print_subheader "Step 3: Optional Settings"
    echo "----------------------------------------"

    local description
    prompt_input "Description (optional)" "$current_description" "description"

    local default_dir
    prompt_input "Default directory (optional)" "$current_default_dir" "default_dir"

    # Show summary
    echo
    print_subheader "Configuration Summary"
    print_table_row "Name:" "$server_name"
    print_table_row "Host:" "$host"
    print_table_row "User:" "$user"
    print_table_row "Port:" "$port"
    print_table_row "Auth:" "$auth_type"
    if [ "$auth_type" = "key" ]; then
        print_table_row "Key:" "$auth_value"
    fi
    if [ -n "$description" ]; then
        print_table_row "Description:" "$description"
    fi
    if [ -n "$default_dir" ]; then
        print_table_row "Default Dir:" "$default_dir"
    fi

    echo
    if prompt_yes_no "Save changes?" "y"; then
        update_server_in_env "$server_name" "$host" "$user" "$auth_type" "$auth_value" "$port" "$description" "$default_dir"

        echo
        if prompt_yes_no "Test connection now?" "y"; then
            test_ssh_connection "$server_name"
        fi
    else
        print_info "Changes cancelled"
    fi
}

# Server selection menu
select_server_menu() {
    local prompt_text="${1:-Select a server}"
    local servers=($(load_servers))
    
    if [ ${#servers[@]} -eq 0 ]; then
        print_warning "No servers configured"
        print_info "Use 'Add New Server' to configure one"
        read -p "Press Enter to continue..."
        return 1
    fi
    
    clear
    print_menu_header "$prompt_text"

    local i=1
    for server in "${servers[@]}"; do
        local host=$(get_server_config "$server" "HOST")
        local user=$(get_server_config "$server" "USER")
        local desc=$(get_server_config "$server" "DESCRIPTION")

        menu_item "$i" "$server  ${GRAY}$user@$host${NC}" "$desc"
        ((i++))
    done

    echo
    menu_item 0 "Cancel"
    menu_prompt "Choose server [0-${#servers[@]}]:"
    
    read choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#servers[@]} ]; then
        selected_server="${servers[$((choice-1))]}"
        return 0
    else
        return 1
    fi
}

# File sync menu
show_sync_menu() {
    clear
    print_header "File Synchronization"
    
    if ! select_server_menu "Select server for file sync"; then
        return
    fi
    
    local server="$selected_server"
    
    clear
    print_menu_header "Sync with $server"
    menu_item 1 "Push (Local → Remote)" "Upload files to $server"
    menu_item 2 "Pull (Remote → Local)" "Download files from $server"
    menu_item 0 "Cancel"
    menu_prompt "Choose direction [0-2]:"
    read direction
    
    case "$direction" in
        1)
            echo
            local source dest
            prompt_input "Local source path" "." "source"
            prompt_input "Remote destination path" "/tmp/" "dest"
            
            echo
            if prompt_yes_no "Dry run first?" "y"; then
                cmd_sync push "$server" "$source" "$dest" --dry-run
                echo
                if prompt_yes_no "Proceed with actual sync?" "y"; then
                    cmd_sync push "$server" "$source" "$dest"
                fi
            else
                cmd_sync push "$server" "$source" "$dest"
            fi
            ;;
        2)
            echo
            local source dest
            prompt_input "Remote source path" "/tmp/" "source"
            prompt_input "Local destination path" "." "dest"
            
            echo
            if prompt_yes_no "Dry run first?" "y"; then
                cmd_sync pull "$server" "$source" "$dest" --dry-run
                echo
                if prompt_yes_no "Proceed with actual sync?" "y"; then
                    cmd_sync pull "$server" "$source" "$dest"
                fi
            else
                cmd_sync pull "$server" "$source" "$dest"
            fi
            ;;
    esac
    
    echo
    read -p "Press Enter to continue..."
}

# Tunnel creation wizard
wizard_create_tunnel() {
    clear
    print_header "SSH Tunnel Creation Wizard"
    
    if ! select_server_menu "Select server for tunnel"; then
        return
    fi
    
    local server="$selected_server"
    
    clear
    print_menu_header "Tunnel through $server"
    menu_item 1 "Local Port Forwarding" "Access a remote service on a local port, e.g. MySQL on 3307"
    menu_item 2 "Remote Port Forwarding" "Expose a local service to the server, e.g. your web server"
    menu_item 3 "Dynamic (SOCKS Proxy)" "A SOCKS5 proxy to route a browser through the server"
    menu_item 0 "Cancel"
    menu_prompt "Choose type [0-3]:"
    read tunnel_type
    
    case "$tunnel_type" in
        1)
            echo
            print_info "Local Port Forwarding Setup"
            echo "Access a remote service as if it were local"
            echo
            local local_port remote_host remote_port
            prompt_input "Local port to listen on" "8080" "local_port"
            prompt_input "Remote host (usually localhost)" "localhost" "remote_host"
            prompt_input "Remote port to forward to" "80" "remote_port"
            
            echo
            print_info "Creating tunnel: localhost:$local_port → $server → $remote_host:$remote_port"
            cmd_tunnel create "$server" local "$local_port:$remote_host:$remote_port"
            
            echo
            print_success "Tunnel created! Access the service at: http://localhost:$local_port"
            ;;
        2)
            echo
            print_info "Remote Port Forwarding Setup"
            echo "Expose your local service to the remote server"
            echo
            local remote_port local_host local_port
            prompt_input "Remote port to listen on" "8080" "remote_port"
            prompt_input "Local host (usually localhost)" "localhost" "local_host"
            prompt_input "Local port to forward" "3000" "local_port"
            
            echo
            print_info "Creating tunnel: $server:$remote_port → local → $local_host:$local_port"
            cmd_tunnel create "$server" remote "$remote_port:$local_host:$local_port"
            
            echo
            print_success "Tunnel created! Remote can access at: $server:$remote_port"
            ;;
        3)
            echo
            print_info "SOCKS Proxy Setup"
            echo "Route all traffic through SSH server"
            echo
            local socks_port
            prompt_input "Local SOCKS port" "1080" "socks_port"
            
            echo
            print_info "Creating SOCKS5 proxy on port $socks_port"
            cmd_tunnel create "$server" dynamic "$socks_port"
            
            echo
            print_success "SOCKS proxy created!"
            print_info "Configure your browser/app to use:"
            echo "  • SOCKS Host: localhost"
            echo "  • SOCKS Port: $socks_port"
            echo "  • SOCKS Type: SOCKS5"
            ;;
    esac
    
    echo
    read -p "Press Enter to continue..."
}
