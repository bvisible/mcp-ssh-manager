import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

export async function setupHermes() {
  console.log('\n======================================================');
  console.log('?? Hermes Agent Integration Setup for MCP SSH Manager');
  console.log('======================================================\n');
  console.log('This wizard will configure a secure, optimized environment');
  console.log('for local open-weights agents like Hermes 3.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise((resolve) => rl.question(query, resolve));

  try {
    const serverName = await question('1. Enter a name for the SSH server (e.g., local-test, prod-safe): ');
    if (!serverName) {
      console.error('Server name cannot be empty. Aborting.');
      process.exit(1);
    }
    const upperName = serverName.toUpperCase().replace(/[^A-Z0-9]/g, '_');

    const host = await question('2. Enter SSH Host/IP: ');
    const user = await question('3. Enter SSH Username: ');
    const keyPath = await question('4. Enter path to SSH private key (e.g., ~/.ssh/id_rsa): ');

    console.log('\n[Security] Autonomous agents require strict safety guardrails.');
    console.log('We will enforce MODE=readonly to prevent destructive bash commands.');
    
    let envContent = '';
    const envPath = path.join(process.cwd(), '.env');
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      if (!envContent.endsWith('\n')) envContent += '\n';
    }

    const auditLogPath = path.join(os.homedir(), '.ssh-manager', 'hermes-audit.jsonl');
    
    envContent += \\n# Hermes Agent Configuration: \\n\;
    envContent += \SSH_SERVER_\_HOST=\System.Management.Automation.Internal.Host.InternalHost\n\;
    envContent += \SSH_SERVER_\_USER=\\n\;
    if (keyPath) envContent += \SSH_SERVER_\_KEYPATH=\\n\;
    envContent += \SSH_SERVER_\_MODE=readonly\n\;
    envContent += \SSH_SERVER_\_AUDIT_LOG=\\n\;

    fs.writeFileSync(envPath, envContent, 'utf8');
    
    console.log(\\n? Saved configuration to .env with READONLY mode and Audit Logging.\);
    
    const mcpConfig = {
      mcpServers: {
        "ssh-manager-hermes": {
          command: "node",
          args: [path.join(process.cwd(), "src", "index.js")],
          env: {
            MCP_CLIENT_ID: "hermes"
          }
        }
      }
    };
    
    const samplePath = path.join(process.cwd(), 'hermes-mcp-config.json');
    fs.writeFileSync(samplePath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    console.log(\? Emitted sample MCP config to: \\);
    console.log('\nNext Steps:');
    console.log('1. Run \ssh-manager tools configure\ if you wish to adjust the tools enabled.');
    console.log('2. Feed \hermes-mcp-config.json\ into your local agent runtime (e.g. open-interpreter, chat UI).');
    console.log('3. All autonomous actions will be logged to: ' + auditLogPath + '\n');
    
  } finally {
    rl.close();
  }
}
