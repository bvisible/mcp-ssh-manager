# Hermes Agent Integration Guide

MCP SSH Manager includes native support for NousResearch's Hermes agent and similar open-weights local autonomous agents. 

Because local agents often have strict token limits and can struggle with complex tool schemas, this integration provides an optimized, safe environment for autonomous server management.

## Key Features for Hermes

1. **Context Window Optimization:** Output truncation is reduced from 10,000 to 4,000 characters to prevent context overflow.
2. **Compact JSON:** Responses are tightly packed to save tokens.
3. **Safety Guardrails:** A default eadonly mode is enforced to prevent destructive bash commands (m -rf, mkfs, etc.).
4. **LLM UX Hints:** If an error occurs (e.g., timeout, command not found, security block), the MCP server appends explicit [Agent Hint: ...] recovery instructions to the stdout, helping the model self-correct.
5. **Reduced Tool Schema:** The hermes configuration preset strips the 37 available tools down to just 4 essential, non-destructive tools (ssh_execute, ssh_list_servers, ssh_health_check, ssh_process_manager).

## Setup Instructions

### 1. Run the Setup Wizard

To initialize a Hermes-optimized configuration, run the setup wizard:

\\\ash
ssh-manager hermes setup
\\\

The wizard will prompt you for your SSH connection details and automatically apply the necessary security modes. It will also generate an audit log location to track what the agent attempts to do.

### 2. Connect Your Agent Runtime

The wizard generates a hermes-mcp-config.json file in your current directory. Feed this configuration into your agent runtime (like open-interpreter or a native Hermes chat interface).

The configuration automatically sets the MCP_CLIENT_ID=hermes environment variable, which activates the optimizations inside the MCP Server.

\\\json
{
  "mcpServers": {
    "ssh-manager-hermes": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ssh-manager/src/index.js"],
      "env": {
        "MCP_CLIENT_ID": "hermes"
      }
    }
  }
}
\\\

### 3. Review the Audit Log

When running an autonomous agent, it is highly recommended to monitor its actions. By default, the wizard configures an audit log path:

\\\ash
tail -f ~/.ssh-manager/hermes-audit.jsonl
\\\

This log records every tool invoked by the agent, along with the command arguments and whether it was blocked by the security policy.

## Adjusting Tool Configuration

If you want to enable more tools for your agent, you can configure the tools preset:

\\\ash
ssh-manager tools configure
\\\

By default, the hermes preset acts similarly to the minimal preset but ensures the agent isn't overwhelmed by excessive documentation and options.

## System Prompt Recommendation

When creating an agent session, consider adding this to its System Prompt:
> "You have access to an SSH management tool. Use 'ssh_health_check' for overviews, and 'ssh_execute' for specific commands. Keep your commands precise. If an error includes an '[Agent Hint]', follow its instructions to recover."
