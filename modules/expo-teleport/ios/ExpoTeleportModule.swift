import ExpoModulesCore
import Teleportmobile
import UIKit

public final class ExpoTeleportModule: Module {
  private let core = TeleportmobileNewCore()!
  private var browserMFARequests: [String: URL] = [:]
  private lazy var eventSink = TerminalEventSink { [weak self] event in
    guard
      let data = event.data(using: .utf8),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return
    }
    DispatchQueue.main.async {
      if
        payload["type"] as? String == "closed",
        let sessionID = payload["sessionId"] as? String
      {
        BackgroundTerminalLease.shared.stop(sessionID: sessionID)
      }
      self?.sendEvent("onTerminalEvent", payload)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoTeleport")

    Events("onTerminalEvent")

    OnCreate {
      core.setEventSink(eventSink)
    }

    OnDestroy {
      core.setEventSink(nil)
      browserMFARequests.removeAll()
    }

    AsyncFunction("getCapabilitiesAsync") {
      core.capabilitiesJSON()
    }

    AsyncFunction("getClipboardTextAsync") { () -> String in
      UIPasteboard.general.string ?? ""
    }.runOnQueue(.main)

    AsyncFunction("exportSessionAsync") { () throws -> String in
      try core.exportSessionJSON()
    }

    AsyncFunction("restoreSessionAsync") { (snapshotJSON: String) throws -> String in
      try core.restoreSessionJSON(snapshotJSON)
    }

    AsyncFunction("logoutAsync") {
      core.logout()
      BackgroundTerminalLease.shared.stopAll()
      BrowserMFALease.shared.stop()
      browserMFARequests.removeAll()
    }

    AsyncFunction("beginLoginAsync") { (requestJSON: String) throws -> String in
      let challengeJSON = try core.beginLoginJSON(requestJSON)
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
      try core.finishTOTP(challengeID, code: code)
    }

    AsyncFunction("finishPasskeyAsync") { [weak self] (challengeID: String, credentialJSON: String, promise: Promise) in
      guard let self else {
        promise.reject(ModuleUnavailableException())
        return
      }
      if !credentialJSON.isEmpty {
        do {
          promise.resolve(try core.finishPasskey(challengeID, credentialJSON: credentialJSON))
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
            promise.resolve(try self.core.finishPasskey(challengeID, credentialJSON: ""))
          } catch {
            promise.reject(error)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("listServersAsync") { () throws -> String in
      try core.listServersJSON()
    }

    AsyncFunction("openSessionAsync") { (targetJSON: String) throws -> String in
      let sessionJSON = try core.openSessionJSON(targetJSON)
      if
        let data = sessionJSON.data(using: .utf8),
        let session = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let sessionID = session["id"] as? String
      {
        BackgroundTerminalLease.shared.start(sessionID: sessionID)
      }
      return sessionJSON
    }

    AsyncFunction("writeSessionAsync") { (sessionID: String, data: String) throws in
      try core.writeSession(sessionID, data: data)
    }

    AsyncFunction("resizeSessionAsync") { (sessionID: String, columns: Int, rows: Int) throws in
      try core.resizeSession(sessionID, columns: columns, rows: rows)
    }

    AsyncFunction("pingSessionAsync") { (sessionID: String) throws in
      try core.pingSession(sessionID)
    }

    AsyncFunction("sessionOutputAsync") { (sessionID: String, afterSequence: Double) throws -> String in
      try core.sessionOutputJSON(sessionID, afterSequence: Int64(afterSequence))
    }

    AsyncFunction("closeSessionAsync") { (sessionID: String) in
      core.closeSession(sessionID)
      BackgroundTerminalLease.shared.stop(sessionID: sessionID)
    }
  }
}

private final class BackgroundTerminalLease {
  static let shared = BackgroundTerminalLease()
  private var identifier: UIBackgroundTaskIdentifier = .invalid
  private var activeSessionID: String?

  func start(sessionID: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      stopOnMainQueue()
      activeSessionID = sessionID
      identifier = UIApplication.shared.beginBackgroundTask(withName: "Telemob terminal") { [weak self] in
        self?.stop(sessionID: sessionID)
      }
    }
  }

  func stop(sessionID: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self, activeSessionID == sessionID else { return }
      stopOnMainQueue()
    }
  }

  func stopAll() {
    DispatchQueue.main.async { [weak self] in
      self?.stopOnMainQueue()
    }
  }

  private func stopOnMainQueue() {
    activeSessionID = nil
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

private final class TerminalEventSink: NSObject, TeleportmobileEventSink {
  private let handler: (String) -> Void

  init(handler: @escaping (String) -> Void) {
    self.handler = handler
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
