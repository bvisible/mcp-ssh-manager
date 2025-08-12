# Quick Start Guide - MCP SSH Manager

Get up and running in 5 minutes! 🚀

## 1️⃣ Clone & Install (1 minute)

```bash
git clone https://github.com/yourusername/mcp-ssh-manager.git
cd mcp-ssh-manager
npm install
pip install -r tools/requirements.txt
```

## 2️⃣ Add Your First Server (2 minutes)

```bash
python tools/server_manager.py
```

Choose option `2` and enter:
- Name: `myserver`
- Host: `your.server.com`
- Username: `yourusername`
- Port: `22`
- Choose `1` for password authentication
- Enter your password

## 3️⃣ Install to Claude Code (1 minute)

```bash
claude mcp add ssh-manager node $(pwd)/src/index.js
```

## 4️⃣ Test It! (1 minute)

Open Claude Code:
```bash
claude
```

Try these commands:
```
"List my SSH servers"
"Execute 'hostname' on myserver"
"Run 'ls -la' on myserver"
```

## 🎉 That's it!

You're now connected to your server through Claude Code!

## 📚 Next Steps

- Add more servers: `python tools/server_manager.py`
- Test connections: `python tools/test-connection.py myserver`
- Read the full [Installation Guide](INSTALLATION.md)
- Check the [README](README.md) for all features

## 🆘 Need Help?

- Server not connecting? Check [Troubleshooting](INSTALLATION.md#troubleshooting)
- MCP not working? Run `/mcp` in Claude Code to check status
- Still stuck? [Open an issue](https://github.com/yourusername/mcp-ssh-manager/issues)