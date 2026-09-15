//
// BotCrossingWallpaper.swift — the colony, behind your windows.
//
// One file, no packages, no Xcode project, no third-party anything: the alternative is handing your
// desktop to a wallpaper app you did not write, and the only honest answer to "should I trust
// this?" is a file short enough to read in one sitting. It does one thing — put a WKWebView
// pointed at the local Bot Crossing server into a borderless window below every ordinary window on
// one display, and keep it alive. Built by `bin/bot-crossing wallpaper build`, which wraps it in a
// minimal .app:
//
//   swiftc -O -swift-version 5 -parse-as-library -framework Cocoa -framework WebKit \
//     -o "Bot Crossing Wallpaper" wallpaper/BotCrossingWallpaper.swift
//
// -swift-version 5 on purpose: nothing here is concurrent — every line runs on the main thread and
// the only timer is the reload backoff — but Swift 6 strict concurrency still rejects the one piece
// of process-wide state below and wants annotations on every AppKit callback, which would roughly
// double the file it is meant to be protecting. -parse-as-library because a lone .swift file is
// otherwise compiled in script mode, where `@main` is an error.
//

import Cocoa
import WebKit

/// stderr by default, a file when `--log` says so: started detached there is no terminal to print
/// to, and "did it load, and if not what did it say?" is all anyone ever asks of a wallpaper.
final class Log {
    private let handle: FileHandle?
    private let stamp: DateFormatter

    init(path: String?) {
        stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd HH:mm:ss"
        guard let path else { handle = FileHandle.standardError; return }
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let file = FileHandle(forWritingAtPath: path)
        file?.seekToEndOfFile()   // append, never truncate — every run shares one file
        handle = file ?? FileHandle.standardError
    }

    /// Unbuffered, so `tail -f data/wallpaper.log` shows a retry while you are still waiting for it.
    func say(_ message: String) {
        handle?.write(Data("[\(stamp.string(from: Date()))] \(message)\n".utf8))
    }
}

/// `--display main | secondary | index N | <part of the screen's name>`.
enum Display {
    case main, secondary, index(Int), named(String)

    static func parse(_ raw: String) -> Display {
        let value = raw.trimmingCharacters(in: .whitespaces)
        if value.caseInsensitiveCompare("main") == .orderedSame { return .main }
        if value.caseInsensitiveCompare("secondary") == .orderedSame { return .secondary }
        if value.lowercased().hasPrefix("index"),
           let n = Int(value.dropFirst(5).trimmingCharacters(in: .whitespaces)) { return .index(n) }
        return .named(value)
    }

    /// nil means "the screen you asked for is not here". The two defaults never return nil — a
    /// laptop with nothing plugged in should still show the colony, so `secondary` degrades to the
    /// built-in display. A screen asked for by number or name does not: quietly painting the laptop
    /// screen because the monitor was unplugged is a surprise, not a fallback, so the caller hides
    /// the window and says so in the log.
    func resolve() -> NSScreen? {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return nil }
        let main = NSScreen.main ?? screens[0]
        switch self {
        case .main: return main
        case .secondary: return screens.first { $0 != main } ?? main
        case .index(let i): return screens.indices.contains(i) ? screens[i] : nil
        case .named(let needle):
            return screens.first { $0.localizedName.range(of: needle, options: .caseInsensitive) != nil }
        }
    }

    var describe: String {
        switch self {
        case .main: return "main"
        case .secondary: return "secondary"
        case .index(let i): return "index \(i)"
        case .named(let n): return "\"\(n)\""
        }
    }
}

struct Options {
    var url = URL(string: "http://127.0.0.1:5274/?wallpaper")!
    var display = Display.secondary
    var interactive = false
    var logPath: String?

    /// A bad argument is never fatal: nobody is watching this process's exit code, so an unusable
    /// value falls back to the default rather than dying into a terminal that does not exist.
    static func parse(_ argv: [String]) -> Options {
        var o = Options()
        var i = 0
        func next() -> String? { i += 1; return i < argv.count ? argv[i] : nil }
        while i < argv.count {
            switch argv[i] {
            case "--url": if let v = next(), let u = URL(string: v), u.scheme != nil { o.url = u }
            case "--display":
                guard var v = next() else { break }
                // `--display index 1` and `--display "index 1"` both work; without this the bare
                // word would be read as a screen *named* "index".
                if v.caseInsensitiveCompare("index") == .orderedSame, let n = next() { v = "index \(n)" }
                o.display = Display.parse(v)
            case "--interactive": o.interactive = true
            case "--log": if let v = next() { o.logPath = v }
            default: break
            }
            i += 1
        }
        return o
    }
}

/// Refuses key and main status even when `--interactive` lets clicks through: a wallpaper that took
/// focus on a stray click would swallow your next sentence. The page still gets the mouse events.
final class WallpaperWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class WallpaperController: NSObject, WKNavigationDelegate {
    private let options: Options
    private let log: Log
    private let window: WallpaperWindow
    private let webView: WKWebView
    private var backoff: TimeInterval = 0   // 0 = nothing has failed yet
    private var retryPending = false
    private var shown = false

    init(options: Options, log: Log) {
        self.options = options
        self.log = log

        let config = WKWebViewConfiguration()
        // Appended to the stock user agent, so data/server.log can tell the wallpaper apart from
        // the browser tab you also have open on the same page.
        config.applicationNameForUserAgent = "BotCrossingWallpaper/1"
        config.suppressesIncrementalRendering = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.underPageBackgroundColor = .black
        // Hidden until the first page finishes: WKWebView paints white while it has nothing, and a
        // screen-sized white rectangle is a far worse "the server isn't up yet" than black — the
        // same reason WebKit's own error page never gets to show.
        webView.isHidden = true

        window = WallpaperWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        // One notch *below the desktop icons*. The desktop is a stack of system windows; measured
        // on macOS 26 it runs picture −2147483625, Dock −2147483624, `.desktopWindow` −2147483623,
        // Finder's icon window −2147483603. Anchoring to the icon window puts us behind the icons
        // and behind every ordinary window (level 0 and up) but in front of the picture. The
        // obvious-looking `.desktopWindow` is the layer the system reserves for drawing that
        // picture, and which of the two wins down there has moved between releases — land under it
        // and the app runs, burns power and is never once seen. Finder's icon window is a thing we
        // can actually point at, and it is where it says it is.
        window.level = NSWindow.Level(Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        // On every Space, unmoved by Mission Control, skipped by window cycling.
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = !options.interactive
        window.isOpaque = true
        window.backgroundColor = .black
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true

        let content = NSView(frame: .zero)
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor
        content.addSubview(webView)
        window.contentView = content

        super.init()
        webView.navigationDelegate = self
    }

    func start() {
        log.say("starting — url \(options.url.absoluteString), display \(options.display.describe), "
                + (options.interactive ? "interactive" : "click-through"))
        // Plugging the side monitor back in should put the colony back on it without a restart.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.place() }
        // A wake usually leaves the socket dead, and a dead socket looks like a frozen colony
        // rather than an error. Reload rather than wonder.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.reload("woke from sleep") }
        place()
        load("first load")
    }

    /// Put the window on the requested screen, or take it away if that screen is gone.
    private func place() {
        guard let screen = options.display.resolve() else {
            let names = NSScreen.screens.map(\.localizedName).joined(separator: ", ")
            log.say("display \(options.display.describe) not connected "
                    + "(have: \(names.isEmpty ? "none" : names)) — window hidden")
            window.orderOut(nil)
            return
        }
        // The *full* frame, not visibleFrame: under the menu bar and the Dock is exactly where a
        // wallpaper belongs, and visibleFrame would leave two grey stripes.
        window.setFrame(screen.frame, display: true)
        webView.frame = window.contentView?.bounds ?? .zero
        // orderFrontRegardless, not makeKeyAndOrderFront: show the window without activating the
        // app, which would pull focus off whatever you were typing into.
        window.orderFrontRegardless()
        log.say("showing on \(screen.localizedName) at \(Int(screen.frame.width))×\(Int(screen.frame.height))")
    }

    private func load(_ reason: String) {
        var request = URLRequest(url: options.url)
        // A cached copy of a page served from localhost buys nothing, and a cached *failure* after
        // a wake is the exact thing we are trying to get out of.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        log.say("loading \(options.url.absoluteString) (\(reason))")
        webView.load(request)
    }

    private func reload(_ reason: String) {
        backoff = 0
        retryPending = false
        load(reason)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        backoff = 0
        if !shown { shown = true; webView.isHidden = false }
        log.say("loaded \(webView.url?.absoluteString ?? options.url.absoluteString)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retry(after: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retry(after: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // WebKit killed the renderer, usually under memory pressure. Nothing is wrong with the
        // server, so go straight back in rather than charging the backoff for someone else's fault.
        log.say("web content process ended — reloading")
        reload("content process restart")
    }

    /// 2s, 4s, 8s … capped at 30s. The common case is "started before the server was up", where two
    /// seconds is plenty; the bad case is a server that never comes back, and retrying every two
    /// seconds forever would keep a core warm all night for nothing.
    private func retry(after error: Error) {
        let ns = error as NSError
        // A load we cancelled ourselves by starting another one is not a failure to back off from.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        // Both delegate callbacks can fire for one failed navigation; one retry is enough.
        guard !retryPending else { return }
        retryPending = true
        backoff = backoff == 0 ? 2 : min(backoff * 2, 30)
        log.say("load failed (\(ns.localizedDescription)) — retrying in \(Int(backoff))s")
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            guard let self else { return }
            self.retryPending = false
            self.load("retry")
        }
    }
}

@main
enum BotCrossingWallpaper {
    // NSApplication holds its delegate weakly and nothing else owns the controller, so it lives here
    // for the life of the process. (Static mutable state is exactly what Swift 6 strict concurrency
    // refuses — see the -swift-version 5 note at the top.)
    static var controller: WallpaperController?

    static func main() {
        let options = Options.parse(Array(CommandLine.arguments.dropFirst()))
        let app = NSApplication.shared
        // .accessory: no Dock tile, no menu bar, no cmd-tab slot, never activated. A wallpaper you
        // have to quit from the Dock is a window, not a wallpaper.
        app.setActivationPolicy(.accessory)
        controller = WallpaperController(options: options, log: Log(path: options.logPath))
        controller?.start()
        // No timers of our own beyond that backoff: when the window is covered WebKit throttles the
        // page's rAF and timers by itself, and that is the whole energy story.
        app.run()
    }
}
