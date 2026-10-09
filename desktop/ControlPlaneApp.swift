// SSH Manager — the desktop shell.
//
// A window around the control plane the engine already serves. It starts
// `ssh-manager control` as a child process, reads the tokenised URL from its
// output, and shows that page in a WKWebView.
//
// Why not Electron: the thing to display is one HTML page that the engine
// already serves over localhost. Electron's runtime alone is 19 MB before any
// application code, and a packaged app is well past a hundred; this binary is a
// few hundred kilobytes and ships no browser of its own. The trade-off is that
// it is macOS-only — elsewhere `ssh-manager control` opens in the browser,
// which is the same interface.
//
// The child process is the interesting part. It holds the approval socket, so
// leaving it running after the window closes would keep agents blocked on a UI
// nobody can see; every exit path therefore terminates it.

import AppKit
import WebKit

// A GUI app launched from Finder inherits a minimal PATH — not the shell's —
// so `node` and `ssh-manager` are invisible unless we look for them. These are
// the standard install locations, plus whatever the user's login shell knows.
let candidatePaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "\(NSHomeDirectory())/bin",
    "\(NSHomeDirectory())/.local/bin",
    "\(NSHomeDirectory())/.nvm/versions/node",
]

/// Locate an executable by name, searching the usual install locations and, as
/// a last resort, asking the user's login shell where it is.
func findExecutable(_ name: String) -> String? {
    for directory in candidatePaths {
        let path = "\(directory)/\(name)"
        if FileManager.default.isExecutableFile(atPath: path) { return path }
    }

    // Ask a login shell: it sources the profile, so it knows about nvm, asdf,
    // volta and anything else the user set up.
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-lc", "command -v \(name)"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let found = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let found, !found.isEmpty, FileManager.default.isExecutableFile(atPath: found) {
            return found
        }
    } catch {
        return nil
    }
    return nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var controlPlane: Process?
    var statusLabel: NSTextField!
    var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "SSH Manager"
        window.center()
        window.setFrameAutosaveName("ControlPlaneWindow")

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView?.addSubview(webView)

        // Shown while the control plane starts, and left in place if it fails —
        // a blank window would be indistinguishable from a hung one.
        statusLabel = NSTextField(labelWithString: "Starting the control plane…")
        statusLabel.frame = NSRect(x: 40, y: window.contentView!.bounds.height / 2, width: 1020, height: 60)
        statusLabel.alignment = .center
        statusLabel.font = NSFont.systemFont(ofSize: 14)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        window.contentView?.addSubview(statusLabel)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startControlPlane()
        installSignalHandlers()
    }

    /// Terminate the child on signals AppKit does not turn into a clean quit.
    /// Without this, `kill` on the app leaves the control plane running and
    /// holding the approval socket.
    func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    /// Launch `ssh-manager control` and wait for it to print its URL.
    func startControlPlane() {
        // SSH_MANAGER_CLI points at a specific CLI. Needed while developing —
        // a machine can carry an older global install that predates `control` —
        // and for any layout the search below does not know about.
        let override = ProcessInfo.processInfo.environment["SSH_MANAGER_CLI"]
        let located = override.flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
            ?? findExecutable("ssh-manager")

        guard let sshManager = located else {
            fail("""
            Could not find ssh-manager.

            Install it first:
                npm install -g mcp-ssh-manager
            or  brew install ssh-manager

            Already installed elsewhere? Point at it with SSH_MANAGER_CLI.
            """)
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: sshManager)
        process.arguments = ["control"]

        // Pass a PATH that includes the usual locations, so the CLI can find
        // node even though this app was launched from Finder.
        var environment = ProcessInfo.processInfo.environment
        let existingPath = environment["PATH"] ?? ""
        environment["PATH"] = (candidatePaths + [existingPath]).joined(separator: ":")
        // Ask the control plane to stop when this app does, however it dies.
        // Opt-in on purpose: inferring it killed control planes started with
        // `ssh-manager control > log &`, where the launching shell exits at once.
        environment["SSH_MANAGER_PARENT_WATCH"] = "1"
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        var buffer = Data()
        var opened = false
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            guard !opened, let text = String(data: buffer, encoding: .utf8) else { return }

            // The CLI prints the URL with its one-time token; that line is the
            // signal that the socket and HTTP server are both up.
            guard let range = text.range(of: #"http://127\.0\.0\.1:\d+/\?token=[a-f0-9]+"#, options: .regularExpression) else { return }
            opened = true
            let url = String(text[range])
            DispatchQueue.main.async { self?.load(url) }
        }

        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard !opened else { return }
                self?.fail("The control plane stopped unexpectedly (exit \(finished.terminationStatus)).")
            }
        }

        do {
            try process.run()
            controlPlane = process
        } catch {
            fail("Could not start the control plane: \(error.localizedDescription)")
        }
    }

    func load(_ url: String) {
        statusLabel.isHidden = true
        webView.load(URLRequest(url: URL(string: url)!))
    }

    func fail(_ message: String) {
        statusLabel.stringValue = message
        statusLabel.isHidden = false
    }

    // The child holds the approval socket. Leaving it alive after the window
    // closes would keep agents waiting on a UI nobody can see.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        controlPlane?.terminate()
        // Give it a moment to refuse anything pending and release the socket.
        let deadline = Date().addingTimeInterval(2)
        while controlPlane?.isRunning == true && Date() < deadline {
            usleep(50_000)
        }
        if controlPlane?.isRunning == true { kill(controlPlane!.processIdentifier, SIGKILL) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
