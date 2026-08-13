import AuthenticationServices
import ExpoModulesCore
import Teleportmobile
import UIKit

public final class ExpoTeleportModule: Module {
  private let core = TeleportmobileNewCore()!
  private var passkeyRequests: [String: PasskeyRequest] = [:]
  private var passkeyCeremony: PasskeyCeremony?
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
      passkeyRequests.removeAll()
      passkeyCeremony = nil
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
      passkeyRequests.removeAll()
      passkeyCeremony = nil
    }

    AsyncFunction("beginLoginAsync") { (requestJSON: String) throws -> String in
      let challengeJSON = try core.beginLoginJSON(requestJSON)
      if let request = try? PasskeyRequest(challengeJSON: challengeJSON) {
        passkeyRequests[request.challengeID] = request
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
      guard let request = passkeyRequests[challengeID] else {
        promise.reject(PasskeyChallengeException())
        return
      }
      guard let anchor = appContext?.utilities?.currentViewController()?.view.window else {
        promise.reject(PasskeyPresentationException())
        return
      }

      let ceremony = PasskeyCeremony(request: request, anchor: anchor) { [weak self] result in
        guard let self else {
          promise.reject(ModuleUnavailableException())
          return
        }
        defer {
          passkeyRequests.removeValue(forKey: challengeID)
          passkeyCeremony = nil
        }
        do {
          let assertionJSON = try result.get()
          promise.resolve(try core.finishPasskey(challengeID, credentialJSON: assertionJSON))
        } catch {
          promise.reject(error)
        }
      }
      passkeyCeremony = ceremony
      ceremony.perform()
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

private struct PasskeyRequest {
  let challengeID: String
  let relyingPartyID: String
  let challenge: Data
  let allowedCredentialIDs: [Data]
  let userVerification: String

  init(challengeJSON: String) throws {
    guard
      let data = challengeJSON.data(using: .utf8),
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["kind"] as? String == "passkey",
      let challengeID = root["challengeId"] as? String,
      let requestJSON = root["requestJson"] as? String,
      let requestData = requestJSON.data(using: .utf8),
      let options = try JSONSerialization.jsonObject(with: requestData) as? [String: Any],
      let relyingPartyID = options["rpId"] as? String,
      let challengeString = options["challenge"] as? String,
      let challenge = Data(base64URLEncoded: challengeString)
    else {
      throw PasskeyChallengeException()
    }
    self.challengeID = challengeID
    self.relyingPartyID = relyingPartyID
    self.challenge = challenge
    self.userVerification = options["userVerification"] as? String ?? "preferred"
    self.allowedCredentialIDs = (options["allowCredentials"] as? [[String: Any]] ?? []).compactMap {
      guard let identifier = $0["id"] as? String else { return nil }
      return Data(base64URLEncoded: identifier)
    }
  }
}

@available(iOS 16.0, *)
private final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private let request: PasskeyRequest
  private let anchor: ASPresentationAnchor
  private let completion: (Result<String, Error>) -> Void

  init(request: PasskeyRequest, anchor: ASPresentationAnchor, completion: @escaping (Result<String, Error>) -> Void) {
    self.request = request
    self.anchor = anchor
    self.completion = completion
  }

  func perform() {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.relyingPartyID)
    let assertion = provider.createCredentialAssertionRequest(challenge: request.challenge)
    assertion.allowedCredentials = request.allowedCredentialIDs.map {
      ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
    }
    switch request.userVerification {
    case "required":
      assertion.userVerificationPreference = .required
    case "discouraged":
      assertion.userVerificationPreference = .discouraged
    default:
      assertion.userVerificationPreference = .preferred
    }
    let controller = ASAuthorizationController(authorizationRequests: [assertion])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    anchor
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
      completion(.failure(UnexpectedPasskeyException()))
      return
    }
    let identifier = assertion.credentialID.base64URLEncodedString()
    var response: [String: Any] = [
      "authenticatorData": assertion.rawAuthenticatorData.base64URLEncodedString(),
      "clientDataJSON": assertion.rawClientDataJSON.base64URLEncodedString(),
      "signature": assertion.signature.base64URLEncodedString(),
    ]
    if !assertion.userID.isEmpty {
      response["userHandle"] = assertion.userID.base64URLEncodedString()
    }
    let credential: [String: Any] = [
      "id": identifier,
      "rawId": identifier,
      "type": "public-key",
      "response": response,
      "extensions": [:],
    ]
    do {
      let encoded = try JSONSerialization.data(withJSONObject: credential)
      guard let json = String(data: encoded, encoding: .utf8) else {
        throw UnexpectedPasskeyException()
      }
      completion(.success(json))
    } catch {
      completion(.failure(error))
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    completion(.failure(error))
  }
}

private extension Data {
  init?(base64URLEncoded value: String) {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
    self.init(base64Encoded: base64)
  }

  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

private final class PasskeyChallengeException: Exception, @unchecked Sendable {
  override var reason: String { "The passkey challenge is missing or invalid." }
}

private final class PasskeyPresentationException: Exception, @unchecked Sendable {
  override var reason: String { "The app must be visible to request a passkey." }
}

private final class UnexpectedPasskeyException: Exception, @unchecked Sendable {
  override var reason: String { "The selected authorization is not a passkey assertion." }
}

private final class ModuleUnavailableException: Exception, @unchecked Sendable {
  override var reason: String { "The Teleport native module is no longer available." }
}
