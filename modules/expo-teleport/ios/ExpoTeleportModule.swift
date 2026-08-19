import ExpoModulesCore
import Teleportmobile
import UIKit

public final class ExpoTeleportModule: Module {
  private let core = TeleportmobileNewCore()!
  private var browserMFARequests: [String: URL] = [:]
  private lazy var eventSink = TerminalEventSink { [weak self] event in
    guard
      let data = event.data(using: .utf8),
      var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return
    }
    NativeTerminalRegistry.shared.handle(event: payload)
    let sessionID = payload["sessionId"] as? String ?? ""
    if let modes = NativeTerminalRegistry.shared.modes(sessionID: sessionID) {
      payload["alternateScreen"] = modes.alternateScreen
      payload["mouseTracking"] = modes.mouseTracking
      payload["bracketedPaste"] = modes.bracketedPaste
    }
    if let effects = NativeTerminalRegistry.shared.takeEffects(sessionID: sessionID) {
      if let title = effects.title { payload["title"] = title }
      if effects.bellCount > 0 { payload["bellCount"] = effects.bellCount }
    }
    if
      let self,
      let response = NativeTerminalRegistry.shared.takePtyWrite(sessionID: sessionID)
    {
      try? self.core.writeSession(sessionID, data: response)
    }
    let eventPayload = payload
    DispatchQueue.main.async {
      if
        eventPayload["type"] as? String == "closed",
        let sessionID = eventPayload["sessionId"] as? String
      {
        BackgroundTerminalLease.shared.stop(sessionID: sessionID)
      }
      if
        eventPayload["type"] as? String == "forward",
        let forward = eventPayload["forward"] as? [String: Any],
        let forwardID = forward["id"] as? String,
        let state = forward["state"] as? String,
        state == "stopped" || state == "error"
      {
        BackgroundTerminalLease.shared.stop(sessionID: "forward:\(forwardID)")
      }
      self?.sendEvent("onTerminalEvent", eventPayload)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoTeleport")

    Events("onTerminalEvent")

    View(TeleportTerminalView.self) {
      Events("onDimensions")

      Prop("sessionId") { (view: TeleportTerminalView, sessionID: String) in
        view.sessionID = sessionID
      }

      Prop("fontSize") { (view: TeleportTerminalView, fontSize: Double) in
        view.fontSize = CGFloat(fontSize)
      }

      AsyncFunction("scrollBy") { (view: TeleportTerminalView, rows: Int) in
        NativeTerminalRegistry.shared.scroll(sessionID: view.sessionID, rows: rows)
      }

      AsyncFunction("scrollToBottom") { (view: TeleportTerminalView) in
        NativeTerminalRegistry.shared.scrollToBottom(sessionID: view.sessionID)
      }

      AsyncFunction("selectRange") {
        (
          view: TeleportTerminalView,
          startColumn: Int,
          startRow: Int,
          endColumn: Int,
          endRow: Int
        ) -> Bool in
        NativeTerminalRegistry.shared.select(
          sessionID: view.sessionID,
          startColumn: startColumn,
          startRow: startRow,
          endColumn: endColumn,
          endRow: endRow
        )
      }

      AsyncFunction("clearSelection") { (view: TeleportTerminalView) in
        NativeTerminalRegistry.shared.clearSelection(sessionID: view.sessionID)
      }

      AsyncFunction("copySelection") { (view: TeleportTerminalView) -> Bool in
        guard
          let text = NativeTerminalRegistry.shared.selectionText(sessionID: view.sessionID),
          !text.isEmpty
        else { return false }
        UIPasteboard.general.string = text
        return true
      }.runOnQueue(.main)

      AsyncFunction("findText") {
        (view: TeleportTerminalView, query: String, backwards: Bool) -> Bool in
        NativeTerminalRegistry.shared.find(
          sessionID: view.sessionID,
          query: query,
          backwards: backwards
        )
      }


      AsyncFunction("hyperlinkAt") {
        (view: TeleportTerminalView, column: Int, row: Int) -> String? in
        NativeTerminalRegistry.shared.hyperlink(
          sessionID: view.sessionID,
          column: column,
          row: row
        )
      }
    }

    OnCreate {
      core.setEventSink(eventSink)
    }

    OnDestroy {
      core.setEventSink(nil)
      BackgroundTerminalLease.shared.stopAll()
      browserMFARequests.removeAll()
    }

    OnAppEntersForeground {
      BackgroundTerminalLease.shared.appEnteredForeground()
    }

    OnAppEntersBackground {
      BackgroundTerminalLease.shared.appEnteredBackground()
    }

    AsyncFunction("getCapabilitiesAsync") {
      core.capabilitiesJSON()
    }

    AsyncFunction("getClipboardTextAsync") { () -> String in
      UIPasteboard.general.string ?? ""
    }.runOnQueue(.main)

    AsyncFunction("exportSessionAsync") { () throws -> String in
      try callGo { error in
        core.exportSessionJSON(error)
      }
    }

    AsyncFunction("restoreSessionAsync") { (snapshotJSON: String) throws -> String in
      try callGo { error in
        core.restoreSessionJSON(snapshotJSON, error: error)
      }
    }

    AsyncFunction("logoutAsync") {
      core.logout()
      NativeTerminalRegistry.shared.closeAll()
      BackgroundTerminalLease.shared.stopAll()
      BrowserMFALease.shared.stop()
      browserMFARequests.removeAll()
    }

    AsyncFunction("beginLoginAsync") { (requestJSON: String) throws -> String in
      let challengeJSON = try callGo { error in
        core.beginLoginJSON(requestJSON, error: error)
      }
      if
        let data = challengeJSON.data(using: .utf8),
        let challenge = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        challenge["kind"] as? String == "passkey",
        let challengeID = challenge["challengeId"] as? String,
        let browserURLString = challenge["browserUrl"] as? String,
        let browserURL = URL(string: browserURLString)
      {
        browserMFARequests[challengeID] = browserURL
      }
      return challengeJSON
    }

    AsyncFunction("finishTotpAsync") { (challengeID: String, code: String) throws -> String in
      try callGo { error in
        core.finishTOTP(challengeID, code: code, error: error)
      }
    }

    AsyncFunction("finishPasskeyAsync") { [weak self] (challengeID: String, credentialJSON: String, promise: Promise) in
      guard let self else {
        promise.reject(ModuleUnavailableException())
        return
      }
      if !credentialJSON.isEmpty {
        do {
          promise.resolve(try callGo { error in
            self.core.finishPasskey(challengeID, credentialJSON: credentialJSON, error: error)
          })
        } catch {
          promise.reject(error)
        }
        return
      }
      guard let browserURL = browserMFARequests[challengeID] else {
        promise.reject(BrowserMFAChallengeException())
        return
      }
      BrowserMFALease.shared.start()
      UIApplication.shared.open(browserURL) { [weak self] opened in
        guard let self else {
          BrowserMFALease.shared.stop()
          promise.reject(ModuleUnavailableException())
          return
        }
        guard opened else {
          BrowserMFALease.shared.stop()
          browserMFARequests.removeValue(forKey: challengeID)
          promise.reject(BrowserMFAPresentationException())
          return
        }
        DispatchQueue.global(qos: .userInitiated).async {
          defer {
            DispatchQueue.main.async {
              self.browserMFARequests.removeValue(forKey: challengeID)
              BrowserMFALease.shared.stop()
            }
          }
          do {
            promise.resolve(try callGo { error in
              self.core.finishPasskey(challengeID, credentialJSON: "", error: error)
            })
          } catch {
            promise.reject(error)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("beginForwardAuthorizationAsync") { (requestJSON: String) throws -> String in
      let challengeJSON = try callGo { error in
        core.beginForwardAuthorizationJSON(requestJSON, error: error)
      }
      if
        let data = challengeJSON.data(using: .utf8),
        let challenge = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        challenge["kind"] as? String == "passkey",
        let challengeID = challenge["challengeId"] as? String,
        let browserURLString = challenge["browserUrl"] as? String,
        let browserURL = URL(string: browserURLString)
      {
        browserMFARequests[challengeID] = browserURL
      }
      return challengeJSON
    }

    AsyncFunction("finishForwardTotpAsync") { (challengeID: String, code: String) throws -> String in
      try callGo { error in
        core.finishForwardTOTP(challengeID, code: code, error: error)
      }
    }

    AsyncFunction("finishForwardPasskeyAsync") { [weak self] (challengeID: String, credentialJSON: String, promise: Promise) in
      guard let self else {
        promise.reject(ModuleUnavailableException())
        return
      }
      if !credentialJSON.isEmpty {
        do {
          promise.resolve(try callGo { error in
            self.core.finishForwardPasskey(challengeID, credentialJSON: credentialJSON, error: error)
          })
        } catch {
          promise.reject(error)
        }
        return
      }
      guard let browserURL = browserMFARequests[challengeID] else {
        promise.reject(BrowserMFAChallengeException())
        return
      }
      BrowserMFALease.shared.start()
      UIApplication.shared.open(browserURL) { [weak self] opened in
        guard let self else {
          BrowserMFALease.shared.stop()
          promise.reject(ModuleUnavailableException())
          return
        }
        guard opened else {
          BrowserMFALease.shared.stop()
          browserMFARequests.removeValue(forKey: challengeID)
          promise.reject(BrowserMFAPresentationException())
          return
        }
        DispatchQueue.global(qos: .userInitiated).async {
          defer {
            DispatchQueue.main.async {
              self.browserMFARequests.removeValue(forKey: challengeID)
              BrowserMFALease.shared.stop()
            }
          }
          do {
            promise.resolve(try callGo { error in
              self.core.finishForwardPasskey(challengeID, credentialJSON: "", error: error)
            })
          } catch {
            promise.reject(error)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("forwardAuthorizationStatusAsync") { () throws -> String in
      try callGo { error in
        core.forwardAuthorizationStatusJSON(error)
      }
    }

    AsyncFunction("startLocalForwardAsync") { (requestJSON: String) throws -> String in
      let forwardJSON = try callGo { error in
        core.startLocalForwardJSON(requestJSON, error: error)
      }
      if
        let data = forwardJSON.data(using: .utf8),
        let forward = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let forwardID = forward["id"] as? String
      {
        BackgroundTerminalLease.shared.start(sessionID: "forward:\(forwardID)")
      }
      return forwardJSON
    }

    AsyncFunction("listLocalForwardsAsync") { () throws -> String in
      try callGo { error in
        core.listLocalForwardsJSON(error)
      }
    }

    AsyncFunction("stopLocalForwardAsync") { (id: String) in
      core.stopLocalForward(id)
      BackgroundTerminalLease.shared.stop(sessionID: "forward:\(id)")
    }

    AsyncFunction("stopAllLocalForwardsAsync") {
      core.stopAllLocalForwards()
      BackgroundTerminalLease.shared.stopAllForwards()
    }

    AsyncFunction("listServersAsync") { () throws -> String in
      try callGo { error in
        core.listServersJSON(error)
      }
    }

    AsyncFunction("openSessionAsync") { (targetJSON: String) throws -> String in
      let sessionJSON = try callGo { error in
        core.openSessionJSON(targetJSON, error: error)
      }
      if
        let data = sessionJSON.data(using: .utf8),
        let session = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let sessionID = session["id"] as? String
      {
        NativeTerminalRegistry.shared.prepare(sessionID: sessionID)
        BackgroundTerminalLease.shared.start(sessionID: sessionID)
      }
      return sessionJSON
    }

    AsyncFunction("writeSessionAsync") { (sessionID: String, data: String) throws in
      try core.writeSession(sessionID, data: data)
    }

    AsyncFunction("sendTerminalKeyAsync") {
      (
        sessionID: String,
        key: String,
        text: String,
        ctrl: Bool,
        alt: Bool,
        shift: Bool,
        action: String
      ) throws in
      if let encoded = NativeTerminalRegistry.shared.encodeKey(
        sessionID: sessionID,
        key: key,
        text: text,
        ctrl: ctrl,
        alt: alt,
        shift: shift,
        action: action
      ) {
        try core.writeSession(sessionID, data: encoded)
      }
    }

    AsyncFunction("sendTerminalMouseTapAsync") {
      (sessionID: String, column: Int, row: Int) throws -> Bool in
      guard let encoded = NativeTerminalRegistry.shared.encodeMouseTap(
        sessionID: sessionID,
        column: column,
        row: row
      ) else { return false }
      try core.writeSession(sessionID, data: encoded)
      return true
    }

    AsyncFunction("sendTerminalMouseEventAsync") {
      (sessionID: String, column: Int, row: Int, action: String) throws -> Bool in
      guard let encoded = NativeTerminalRegistry.shared.encodeMouseEvent(
        sessionID: sessionID,
        column: column,
        row: row,
        action: action
      ) else { return false }
      try core.writeSession(sessionID, data: encoded)
      return true
    }

    AsyncFunction("sendTerminalMouseScrollAsync") {
      (
        sessionID: String,
        column: Int,
        row: Int,
        direction: String,
        steps: Int
      ) throws -> Bool in
      guard let encoded = NativeTerminalRegistry.shared.encodeMouseScroll(
        sessionID: sessionID,
        column: column,
        row: row,
        direction: direction,
        steps: steps
      ) else { return false }
      try core.writeSession(sessionID, data: encoded)
      return true
    }

    AsyncFunction("sendTerminalFocusAsync") { (sessionID: String, focused: Bool) throws in
      if let encoded = NativeTerminalRegistry.shared.encodeFocus(
        sessionID: sessionID,
        focused: focused
      ) {
        try core.writeSession(sessionID, data: encoded)
      }
    }

    AsyncFunction("pasteSessionAsync") { (sessionID: String, data: String) throws in
      if let encoded = NativeTerminalRegistry.shared.encodePaste(
        sessionID: sessionID,
        data: data
      ) {
        try core.writeSession(sessionID, data: encoded)
      }
    }

    AsyncFunction("resizeSessionAsync") { (sessionID: String, columns: Int, rows: Int) throws in
      try core.resizeSession(sessionID, columns: columns, rows: rows)
    }

    AsyncFunction("pingSessionAsync") { (sessionID: String) throws in
      try core.pingSession(sessionID)
    }

    AsyncFunction("sessionOutputAsync") { (sessionID: String, afterSequence: Double) throws -> String in
      let output = try callGo { error in
        core.sessionOutputJSON(sessionID, afterSequence: Int64(afterSequence), error: error)
      }
      NativeTerminalRegistry.shared.handle(replayJSON: output)
      if let response = NativeTerminalRegistry.shared.takePtyWrite(sessionID: sessionID) {
        try core.writeSession(sessionID, data: response)
      }
      guard
        let data = output.data(using: .utf8),
        var payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { return output }
      if let modes = NativeTerminalRegistry.shared.modes(sessionID: sessionID) {
        payload["alternateScreen"] = modes.alternateScreen
        payload["mouseTracking"] = modes.mouseTracking
        payload["bracketedPaste"] = modes.bracketedPaste
      }
      let encoded = try JSONSerialization.data(withJSONObject: payload)
      return String(decoding: encoded, as: UTF8.self)
    }

    AsyncFunction("closeSessionAsync") { (sessionID: String) in
      core.closeSession(sessionID)
      NativeTerminalRegistry.shared.close(sessionID: sessionID)
      BackgroundTerminalLease.shared.stop(sessionID: sessionID)
    }
  }
}

private func callGo<Result>(_ operation: (NSErrorPointer) -> Result) throws -> Result {
  // gomobile's object-returning Objective-C methods keep an explicit NSError
  // pointer in Swift. Its BOOL-returning methods are imported as `throws`
  // instead and must be called directly without this helper.
  var operationError: NSError?
  let result = operation(&operationError)
  if let operationError {
    throw operationError
  }
  return result
}

private final class BackgroundTerminalLease {
  static let shared = BackgroundTerminalLease()
  private var identifier: UIBackgroundTaskIdentifier = .invalid
  private var activeSessionIDs = Set<String>()

  func start(sessionID: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      activeSessionIDs.insert(sessionID)
      beginTaskOnMainQueue()
    }
  }

  func stop(sessionID: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      activeSessionIDs.remove(sessionID)
      if activeSessionIDs.isEmpty { endTaskOnMainQueue() }
    }
  }

  func stopAll() {
    DispatchQueue.main.async { [weak self] in
      self?.activeSessionIDs.removeAll()
      self?.endTaskOnMainQueue()
    }
  }

  func stopAllForwards() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      activeSessionIDs = Set(activeSessionIDs.filter { !$0.hasPrefix("forward:") })
      if activeSessionIDs.isEmpty { endTaskOnMainQueue() }
    }
  }

  func appEnteredForeground() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      // A UIKit background assertion is finite and belongs to one foreground /
      // background cycle. Balance the previous assertion, then request the next
      // one early while the app is foregrounded as Apple recommends.
      endTaskOnMainQueue()
      beginTaskOnMainQueue()
    }
  }

  func appEnteredBackground() {
    DispatchQueue.main.async { [weak self] in
      // Normally the foreground callback or session registration requested the
      // assertion already. This is a fallback for unusual lifecycle ordering.
      self?.beginTaskOnMainQueue()
    }
  }

  private func beginTaskOnMainQueue() {
    guard !activeSessionIDs.isEmpty, identifier == .invalid else { return }
    identifier = UIApplication.shared.beginBackgroundTask(
      withName: "Telemob terminals"
    ) { [weak self] in
      // UIKit invokes this synchronously on the main thread. End the assertion
      // before returning or iOS may terminate the process. Keep the active IDs
      // so a later foreground transition can arm a fresh finite assertion.
      self?.endTaskOnMainQueue()
    }
  }

  private func endTaskOnMainQueue() {
    if identifier != .invalid {
      UIApplication.shared.endBackgroundTask(identifier)
      identifier = .invalid
    }
  }
}

private final class BrowserMFALease {
  static let shared = BrowserMFALease()
  private var identifier: UIBackgroundTaskIdentifier = .invalid

  func start() {
    stop()
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Telemob Browser MFA") { [weak self] in
      self?.stop()
    }
  }

  func stop() {
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}

private final class TerminalEventSink: NSObject, TeleportmobileEventSinkProtocol {
  private let handler: (String) -> Void

  init(handler: @escaping (String) -> Void) {
    self.handler = handler
  }

  func onTerminalData(_ sessionID: String?, sequence: Int64, data: Data?) {
    guard let sessionID, let data else { return }
    NativeTerminalRegistry.shared.handleData(
      sessionID: sessionID,
      sequence: sequence,
      data: data
    )
  }

  func onTerminalEvent(_ eventJSON: String?) {
    if let eventJSON {
      handler(eventJSON)
    }
  }
}

private final class BrowserMFAChallengeException: Exception, @unchecked Sendable {
  override var reason: String { "The Browser MFA challenge is missing or expired." }
}

private final class BrowserMFAPresentationException: Exception, @unchecked Sendable {
  override var reason: String { "The system browser could not open Browser MFA." }
}

private final class ModuleUnavailableException: Exception, @unchecked Sendable {
  override var reason: String { "The Teleport native module is no longer available." }
}
