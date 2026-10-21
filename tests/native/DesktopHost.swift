import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

@MainActor
final class DeliveryCountingView: NSView {
  private(set) var mouseDowns = 0
  private(set) var scrolls = 0
  private(set) var keyDowns = 0

  override var acceptsFirstResponder: Bool { true }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) { mouseDowns += 1 }

  override func scrollWheel(with event: NSEvent) { scrolls += 1 }

  override func keyDown(with event: NSEvent) { keyDowns += 1 }
}

@MainActor
final class DesktopHost: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let pid = ProcessInfo.processInfo.processIdentifier
  private let previousApplication: NSRunningApplication?
  private let window: NSWindow
  private let view: DeliveryCountingView
  private var inputSource: DispatchSourceRead?
  private var inputLine = Data()
  private var discardingLongLine = false
  private var stopping = false
  private var restoredPreviousApplication = false
  private var fullscreen = false
  private let maximumLineBytes = 8 * 1024

  init(previousApplication: NSRunningApplication?) {
    self.previousApplication = previousApplication
    let contentRect = NSRect(x: 0, y: 0, width: 600, height: 400)
    window = NSWindow(
      contentRect: contentRect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    view = DeliveryCountingView(frame: contentRect)
    super.init()
    window.title = "pagent desktop test"
    window.backgroundColor = .white
    window.collectionBehavior = [.fullScreenPrimary]
    window.isReleasedWhenClosed = false
    window.isRestorable = false
    window.contentView = view
    window.delegate = self
    window.center()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    activate()
    emit(["ready": true, "pid": Int(pid)])
    guard !stopping else { return }
    let flags = fcntl(STDIN_FILENO, F_GETFL)
    guard flags >= 0, fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
      fail(nil, "Unable to configure nonblocking stdin")
      shutdown()
      return
    }

    let source = DispatchSource.makeReadSource(
      fileDescriptor: FileHandle.standardInput.fileDescriptor,
      queue: .main
    )
    source.setEventHandler { [weak self] in
      MainActor.assumeIsolated {
        self?.readStandardInput()
      }
    }
    inputSource = source
    source.resume()
  }

  func applicationWillTerminate(_ notification: Notification) {
    inputSource?.cancel()
    restorePreviousApplication()
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    shutdown()
    return false
  }

  func windowDidEnterFullScreen(_ notification: Notification) {
    fullscreen = true
  }

  func windowDidExitFullScreen(_ notification: Notification) {
    fullscreen = false
  }

  private func readStandardInput() {
    guard !stopping else { return }
    var buffer = [UInt8](repeating: 0, count: 4096)
    let count = buffer.withUnsafeMutableBytes {
      Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count)
    }
    if count < 0 {
      if errno != EINTR && errno != EAGAIN {
        fail(nil, "Unable to read stdin")
        shutdown()
      }
      return
    }
    guard count > 0 else {
      if !inputLine.isEmpty && !discardingLongLine {
        processLine(inputLine)
      }
      shutdown()
      return
    }
    for byte in buffer.prefix(count) {
      guard !stopping else { return }
      if byte == 0x0A {
        if !discardingLongLine {
          processLine(inputLine)
        }
        inputLine.removeAll(keepingCapacity: true)
        discardingLongLine = false
      } else if !discardingLongLine {
        if inputLine.count == maximumLineBytes {
          inputLine.removeAll(keepingCapacity: true)
          discardingLongLine = true
          fail(nil, "Input line exceeds 8192 bytes")
        } else {
          inputLine.append(byte)
        }
      }
    }
  }

  private func processLine(_ data: Data) {
    let object: Any
    do {
      object = try JSONSerialization.jsonObject(with: data)
    } catch {
      fail(nil, "Expected one JSON object per line")
      return
    }
    guard let request = object as? [String: Any] else {
      fail(nil, "Expected one JSON object per line")
      return
    }
    guard let id = integer(request["id"]) else {
      fail(nil, "id must be an integer")
      return
    }
    guard let command = request["command"] as? String else {
      fail(id, "command must be a string")
      return
    }

    switch command {
    case "status":
      let frame = window.frame
      let frontmostPid: Any
      if let frontmost = NSWorkspace.shared.frontmostApplication {
        frontmostPid = Int(frontmost.processIdentifier)
      } else {
        frontmostPid = NSNull()
      }
      respond(
        id,
        [
          "pid": Int(pid),
          "frontmostPid": frontmostPid,
          "fullscreen": fullscreen,
          "mouseDowns": view.mouseDowns,
          "scrolls": view.scrolls,
          "keyDowns": view.keyDowns,
          "bounds": [
            "x": Double(frame.minX),
            "y": Double(CGDisplayBounds(CGMainDisplayID()).height - frame.maxY),
            "width": Double(frame.width),
            "height": Double(frame.height),
          ],
        ])
    case "move", "down", "up", "drag":
      guard let x = finiteDouble(request["x"]), let y = finiteDouble(request["y"]) else {
        fail(id, "x and y must be finite numbers")
        return
      }
      guard inputIsTrusted(id) else { return }
      let type: CGEventType
      switch command {
      case "move": type = .mouseMoved
      case "down": type = .leftMouseDown
      case "up": type = .leftMouseUp
      default: type = .leftMouseDragged
      }
      guard
        let event = CGEvent(
          mouseEventSource: nil,
          mouseType: type,
          mouseCursorPosition: CGPoint(x: x, y: y),
          mouseButton: .left
        )
      else {
        fail(id, "Unable to create mouse event")
        return
      }
      event.flags = []
      if command == "down" || command == "up" {
        event.setIntegerValueField(.mouseEventClickState, value: 1)
      }
      event.post(tap: .cghidEventTap)
      respond(id, ["ok": true])
    case "scroll":
      guard let delta = integer(request["delta"]), let wheelDelta = Int32(exactly: delta) else {
        fail(id, "delta must be an integer within the Int32 range")
        return
      }
      guard inputIsTrusted(id) else { return }
      guard
        let event = CGEvent(
          scrollWheelEvent2Source: nil,
          units: .pixel,
          wheelCount: 1,
          wheel1: wheelDelta,
          wheel2: 0,
          wheel3: 0
        )
      else {
        fail(id, "Unable to create scroll event")
        return
      }
      event.flags = []
      event.post(tap: .cghidEventTap)
      respond(id, ["ok": true])
    case "key":
      guard inputIsTrusted(id) else { return }
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      else {
        fail(id, "Unable to create fixed A key events")
        return
      }
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail(id, "Refusing to send a key: fixture is not the frontmost application")
        return
      }
      down.flags = []
      up.flags = []
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      respond(id, ["ok": true])
    case "fullscreen":
      window.toggleFullScreen(nil)
      respond(id, ["ok": true])
    case "activate":
      activate()
      respond(id, ["ok": true])
    case "place":
      guard !fullscreen, let x = finiteDouble(request["x"]),
        let y = finiteDouble(request["y"]),
        abs(x) <= 1_000_000, abs(y) <= 1_000_000
      else {
        fail(id, "Expected bounded coordinates for a non-fullscreen window")
        return
      }
      window.setFrameOrigin(
        NSPoint(
          x: x,
          y: Double(CGDisplayBounds(CGMainDisplayID()).height - window.frame.height) - y
        ))
      respond(id, ["ok": true])
    case "observe":
      guard let observedPid = integer(request["pid"]), observedPid > 0,
        observedPid <= Int(Int32.max)
      else {
        fail(id, "pid must be a positive Int32 integer")
        return
      }
      observe(id, pid: observedPid)
    case "quit":
      respond(id, ["ok": true])
      shutdown()
    default:
      fail(id, "Unknown command")
    }
  }

  private func observe(_ id: Int, pid observedPid: Int) {
    guard
      let information = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
        as? [[String: Any]]
    else {
      fail(id, "Unable to read on-screen window geometry")
      return
    }
    var windows: [[String: Any]] = []
    for entry in information {
      guard integer(entry[kCGWindowOwnerPID as String]) == observedPid else { continue }
      guard let bounds = entry[kCGWindowBounds as String] as? [String: Any],
        let x = finiteDouble(bounds["X"]), let y = finiteDouble(bounds["Y"]),
        let width = finiteDouble(bounds["Width"]),
        let height = finiteDouble(bounds["Height"]),
        let layer = integer(entry[kCGWindowLayer as String]),
        let onscreen = entry[kCGWindowIsOnscreen as String] as? Bool
      else {
        fail(id, "Incomplete window geometry for requested pid")
        return
      }
      windows.append([
        "x": x, "y": y, "width": width, "height": height,
        "layer": layer, "onscreen": onscreen,
      ])
    }
    respond(id, ["windows": windows])
  }

  private func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
    return number as? Int
  }

  private func finiteDouble(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite
    else { return nil }
    return number.doubleValue
  }

  private func inputIsTrusted(_ id: Int) -> Bool {
    guard AXIsProcessTrusted() else {
      fail(
        id, "Accessibility permission is required to post input; no permission prompt was requested"
      )
      return false
    }
    return true
  }

  private func activate() {
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    window.makeFirstResponder(view)
  }

  private func respond(_ id: Int, _ fields: [String: Any]) {
    var response = fields
    response["id"] = id
    emit(response)
  }

  private func fail(_ id: Int?, _ message: String) {
    emit(["id": id.map { $0 as Any } ?? NSNull(), "ok": false, "error": message])
  }

  private func emit(_ response: [String: Any]) {
    guard !stopping else { return }
    do {
      var data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
      data.append(0x0A)
      try FileHandle.standardOutput.write(contentsOf: data)
    } catch {
      shutdown()
    }
  }

  private func restorePreviousApplication() {
    guard !restoredPreviousApplication else { return }
    restoredPreviousApplication = true
    if let previousApplication, previousApplication.processIdentifier != pid,
      !previousApplication.isTerminated
    {
      if #available(macOS 14.0, *) {
        NSApplication.shared.yieldActivation(to: previousApplication)
      }
      previousApplication.activate(options: [])
    }
  }

  private func shutdown() {
    guard !stopping else { return }
    stopping = true
    inputSource?.cancel()
    window.close()
    restorePreviousApplication()
    NSApplication.shared.terminate(nil)
  }
}

MainActor.assumeIsolated {
  let previousApplication = NSWorkspace.shared.frontmostApplication
  let application = NSApplication.shared
  application.setActivationPolicy(.regular)
  let host = DesktopHost(previousApplication: previousApplication)
  application.delegate = host
  withExtendedLifetime(host) {
    application.run()
  }
}
