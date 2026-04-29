#!/bin/bash
# Interactive menu library for ssh-manager CLI

# Display main menu
show_main_menu() {
    clear
    print_header "SSH Manager CLI v$VERSION"
    echo
    echo -e "  ${CYAN}1)${NC} ${SERVER} Server Management"
    echo "     Add, list, test, and manage SSH servers"
    echo
    echo -e "  ${CYAN}2)${NC} ${SESSION} Quick Connect"
    echo "     Connect to a server via SSH"
    echo
    echo -e "  ${CYAN}3)${NC} ${SYNC} File Synchronization"
    echo "     Push/pull files with rsync"
    echo
    echo -e "  ${CYAN}4)${NC} ${TUNNEL} SSH Tunnels"
    echo "     Create and manage SSH tunnels"
    echo
    echo -e "  ${CYAN}5)${NC} ${MONITOR} System Monitoring"
    echo "     Monitor server resources"
    echo
    echo -e "  ${CYAN}6)${NC} ${ROCKET} Execute Commands"
    echo "     Run commands on servers"
    echo
    echo -e "  ${CYAN}7)${NC} ${GEAR} Configuration"
    echo "     Edit settings and preferences"
    echo
    echo -e "  ${CYAN}8)${NC} ${INFO} Help & Documentation"
    echo "     View help and examples"
    echo
    echo -e "  ${CYAN}0)${NC} Exit"
    echo
    echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -n "Choose an option [0-8]: "
}

# Server management submenu
show_server_menu() {
    clear
    print_header "Server Management"
    echo
    echo -e "  ${CYAN}1)${NC} ${CHECK} Add New Server"
    echo "     Configure a new SSH server"
    echo
    echo -e "  ${CYAN}2)${NC} ${CLIPBOARD} List All Servers"
    echo "     Show configured servers"
    echo
    echo -e "  ${CYAN}3)${NC} ${WRENCH} Test Connection"
    echo "     Test server connectivity"
    echo
    echo -e "  ${CYAN}4)${NC} ${INFO}  Show Server Details"
    echo "     Display server configuration"
    echo
    echo -e "  ${CYAN}5)${NC} ${PENCIL}  Edit Server"
    echo "     Modify server settings"
    echo
    echo -e "  ${CYAN}6)${NC} ${CROSS} Remove Server"
    echo "     Delete server configuration"
    echo
    echo -e "  ${CYAN}7)${NC} ${NOTE} Edit Config File"
    echo "     Directly edit .env file"
    echo
    echo -e "  ${CYAN}0)${NC} ← Back to Main Menu"
    echo
    echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -n "Choose an option [0-7]: "
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
    
    echo
    if prompt_yes_no "Save this configuration?" "y"; then
        # Save to .env
        add_server_to_env "$server_name" "$host" "$user" "$auth_type" "$auth_value" "$port" "$description"
        
        # Add default directory if specified
        if [ -n "$default_dir" ]; then
            local name_upper="$(echo "$server_name" | tr '[:lower:]' '[:upper:]')"
            echo "SSH_SERVER_${name_upper}_DEFAULT_DIR=$default_dir" >> "$SSH_MANAGER_ENV"
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

    local server_name="$SELECTED_SERVER"

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
    print_header "$prompt_text"
    echo
    
    local i=1
    for server in "${servers[@]}"; do
        local host=$(get_server_config "$server" "HOST")
        local user=$(get_server_config "$server" "USER")
        local desc=$(get_server_config "$server" "DESCRIPTION")
        
        echo -e "  ${CYAN}$i)${NC} ${SERVER}$server"
        echo "     $user@$host"
        if [ -n "$desc" ]; then
            echo "     ${GRAY}$desc${NC}"
        fi
        echo
        ((i++))
    done
    
    echo -e "  ${CYAN}0)${NC} Cancel"
    echo
    echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -n "Choose server [0-${#servers[@]}]: "
    
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
    
    echo
    print_subheader "Sync Direction"
    echo -e "  ${CYAN}1)${NC} ${ARROW} Push (Local → Remote)"
    echo "     Upload files to $server"
    echo
    echo -e "  ${CYAN}2)${NC} ${ARROW} Pull (Remote → Local)"
    echo "     Download files from $server"
    echo
    echo -e "  ${CYAN}0)${NC} Cancel"
    echo
    read -p "Choose direction [0-2]: " direction
    
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
    
    echo
    print_subheader "Tunnel Type"
    echo -e "  ${CYAN}1)${NC} Local Port Forwarding"
    echo "     Access remote service through local port"
    echo "     Example: Access remote MySQL on local port 3307"
    echo
    echo -e "  ${CYAN}2)${NC} Remote Port Forwarding"
    echo "     Expose local service to remote server"
    echo "     Example: Let remote access your local web server"
    echo
    echo -e "  ${CYAN}3)${NC} Dynamic (SOCKS Proxy)"
    echo "     Create SOCKS5 proxy for secure browsing"
    echo "     Example: Route browser through SSH server"
    echo
    echo -e "  ${CYAN}0)${NC} Cancel"
    echo
    read -p "Choose type [0-3]: " tunnel_type
    
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