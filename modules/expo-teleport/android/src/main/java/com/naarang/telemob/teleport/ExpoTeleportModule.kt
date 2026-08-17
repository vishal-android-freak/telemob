package com.naarang.telemob.teleport

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import teleportmobile.EventSink
import kotlin.coroutines.resume

class ExpoTeleportModule : Module() {
  private val core by lazy { TeleportCoreHolder.core }
  private val browserMFARequests = mutableMapOf<String, String>()
  private val eventSink = object : EventSink {
    override fun onTerminalData(sessionID: String, sequence: Long, data: ByteArray) {
      NativeTerminalRegistry.handleData(sessionID, sequence, data)
    }

    override fun onTerminalEvent(eventJSON: String) {
      val event = JSONObject(eventJSON)
      NativeTerminalRegistry.handleEvent(event)
      val sessionId = event.optString("sessionId")
      NativeTerminalRegistry.modes(sessionId)?.let { modes ->
        event.put("alternateScreen", modes.alternateScreen)
        event.put("mouseTracking", modes.mouseTracking)
        event.put("bracketedPaste", modes.bracketedPaste)
      }
      NativeTerminalRegistry.takeEffects(sessionId)?.let { effects ->
        effects.title?.let { event.put("title", it) }
        if (effects.bellCount > 0) event.put("bellCount", effects.bellCount)
      }
      flushTerminalResponse(sessionId)
      if (event.optString("type") == "closed") {
        appContext.reactContext?.let { context ->
          TerminalForegroundService.release(context, event.optString("sessionId"))
        }
      }
      if (event.optString("type") == "forward") {
        val forward = event.optJSONObject("forward")
        if (forward?.optString("state") in setOf("stopped", "error")) {
          appContext.reactContext?.let { context ->
            TerminalForegroundService.releaseForward(context, forward?.optString("id").orEmpty())
          }
        }
      }
      sendEvent("onTerminalEvent", event.toMap())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoTeleport")

    Events("onTerminalEvent")

    View(TeleportTerminalView::class) {
      Events("onDimensions")

      Prop("sessionId") { view: TeleportTerminalView, sessionId: String ->
        view.sessionId = sessionId
      }

      Prop("fontSize") { view: TeleportTerminalView, fontSize: Float ->
        view.fontSize = fontSize
      }

      AsyncFunction("scrollBy") { view: TeleportTerminalView, rows: Int ->
        NativeTerminalRegistry.scroll(view.sessionId, rows)
      }

      AsyncFunction("scrollToBottom") { view: TeleportTerminalView ->
        NativeTerminalRegistry.scrollToBottom(view.sessionId)
      }

      AsyncFunction("selectRange") {
          view: TeleportTerminalView,
          startColumn: Int,
          startRow: Int,
          endColumn: Int,
          endRow: Int ->
        NativeTerminalRegistry.select(
          view.sessionId,
          startColumn,
          startRow,
          endColumn,
          endRow
        )
      }

      AsyncFunction("clearSelection") { view: TeleportTerminalView ->
        NativeTerminalRegistry.clearSelection(view.sessionId)
      }

      AsyncFunction("copySelection") { view: TeleportTerminalView ->
        val text = NativeTerminalRegistry.selectionText(view.sessionId).orEmpty()
        if (text.isNotEmpty()) {
          val context = appContext.reactContext
            ?: throw IllegalStateException("The app context is unavailable.")
          val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Terminal selection", text))
        }
        text.isNotEmpty()
      }

      AsyncFunction("findText") {
          view: TeleportTerminalView,
          query: String,
          backwards: Boolean ->
        NativeTerminalRegistry.find(view.sessionId, query, backwards)
      }

      AsyncFunction("hyperlinkAt") {
          view: TeleportTerminalView,
          column: Int,
          row: Int ->
        NativeTerminalRegistry.hyperlink(view.sessionId, column, row)
      }
    }

    OnCreate {
      core.setEventSink(eventSink)
    }

    OnDestroy {
      core.setEventSink(null)
      browserMFARequests.clear()
    }

    AsyncFunction("getCapabilitiesAsync") {
      core.capabilitiesJSON()
    }

    AsyncFunction("getClipboardTextAsync") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("The app context is unavailable.")
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
    }

    AsyncFunction("exportSessionAsync") {
      core.exportSessionJSON()
    }

    AsyncFunction("restoreSessionAsync") { snapshotJSON: String ->
      core.restoreSessionJSON(snapshotJSON)
    }

    AsyncFunction("logoutAsync") {
      core.logout()
      NativeTerminalRegistry.closeAll()
      appContext.reactContext?.let(TerminalForegroundService::stop)
      browserMFARequests.clear()
    }

    AsyncFunction("beginLoginAsync") { requestJSON: String ->
      core.beginLoginJSON(requestJSON).also { challengeJSON ->
        val challenge = JSONObject(challengeJSON)
        if (challenge.optString("kind") == "passkey") {
          browserMFARequests[challenge.getString("challengeId")] = challenge.getString("browserUrl")
        }
      }
    }

    AsyncFunction("finishTotpAsync") { challengeID: String, code: String ->
      core.finishTOTP(challengeID, code)
    }

    AsyncFunction("finishPasskeyAsync") Coroutine { challengeID: String, credentialJSON: String ->
      if (credentialJSON.isNotBlank()) {
        return@Coroutine core.finishPasskey(challengeID, credentialJSON)
      }
      val browserURL = browserMFARequests[challengeID]
        ?: throw IllegalStateException("The Browser MFA challenge is missing or expired.")
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("The app must be visible to open Browser MFA.")
      withContext(Dispatchers.Main) {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(browserURL)))
      }
      try {
        core.finishPasskey(challengeID, "")
      } finally {
        browserMFARequests.remove(challengeID)
      }
    }

    AsyncFunction("beginForwardAuthorizationAsync") { requestJSON: String ->
      core.beginForwardAuthorizationJSON(requestJSON).also { challengeJSON ->
        val challenge = JSONObject(challengeJSON)
        if (challenge.optString("kind") == "passkey") {
          browserMFARequests[challenge.getString("challengeId")] = challenge.getString("browserUrl")
        }
      }
    }

    AsyncFunction("finishForwardTotpAsync") { challengeID: String, code: String ->
      core.finishForwardTOTP(challengeID, code)
    }

    AsyncFunction("finishForwardPasskeyAsync") Coroutine { challengeID: String, credentialJSON: String ->
      if (credentialJSON.isNotBlank()) {
        return@Coroutine core.finishForwardPasskey(challengeID, credentialJSON)
      }
      val browserURL = browserMFARequests[challengeID]
        ?: throw IllegalStateException("The Browser MFA challenge is missing or expired.")
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("The app must be visible to open Browser MFA.")
      withContext(Dispatchers.Main) {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(browserURL)))
      }
      try {
        core.finishForwardPasskey(challengeID, "")
      } finally {
        browserMFARequests.remove(challengeID)
      }
    }

    AsyncFunction("forwardAuthorizationStatusAsync") {
      core.forwardAuthorizationStatusJSON()
    }

    AsyncFunction("startLocalForwardAsync") Coroutine { requestJSON: String ->
      awaitNotificationPermission()
      core.startLocalForwardJSON(requestJSON).also { forwardJSON ->
        val forward = JSONObject(forwardJSON)
        appContext.reactContext?.let { context ->
          TerminalForegroundService.startForward(
            context,
            forward.getString("id"),
            "${forward.optString("localHost")}:${forward.optInt("localPort")} → ${forward.optString("remoteHost")}:${forward.optInt("remotePort")}",
          )
        }
      }
    }

    AsyncFunction("listLocalForwardsAsync") {
      core.listLocalForwardsJSON()
    }

    AsyncFunction("stopLocalForwardAsync") { id: String ->
      core.stopLocalForward(id)
      appContext.reactContext?.let { context ->
        TerminalForegroundService.releaseForward(context, id)
      }
    }

    AsyncFunction("stopAllLocalForwardsAsync") {
      core.stopAllLocalForwards()
      appContext.reactContext?.let(TerminalForegroundService::releaseAllForwards)
    }

    AsyncFunction("listServersAsync") {
      core.listServersJSON()
    }

    AsyncFunction("openSessionAsync") Coroutine { targetJSON: String ->
      awaitNotificationPermission()
      core.openSessionJSON(targetJSON).also { sessionJSON ->
        val session = JSONObject(sessionJSON)
        NativeTerminalRegistry.prepare(session.getString("id"))
        val target = JSONObject(targetJSON)
        appContext.reactContext?.let { context ->
          TerminalForegroundService.start(
            context,
            session.getString("id"),
            "${target.optString("login")}@${target.optString("hostname")}",
            target.optString("tabId")
          )
        }
      }
    }

    AsyncFunction("writeSessionAsync") { sessionID: String, data: String ->
      core.writeSession(sessionID, data)
    }

    AsyncFunction("sendTerminalKeyAsync") {
        sessionID: String,
        key: String,
        text: String,
        ctrl: Boolean,
        alt: Boolean,
        shift: Boolean,
        action: String ->
      NativeTerminalRegistry.encodeKey(
        sessionID,
        key,
        text,
        ctrl,
        alt,
        shift,
        action
      )?.let { core.writeSession(sessionID, it) }
    }

    AsyncFunction("sendTerminalMouseTapAsync") {
        sessionID: String,
        column: Int,
        row: Int ->
      val encoded = NativeTerminalRegistry.encodeMouseTap(sessionID, column, row)
      if (encoded != null) core.writeSession(sessionID, encoded)
      encoded != null
    }

    AsyncFunction("sendTerminalMouseEventAsync") {
        sessionID: String,
        column: Int,
        row: Int,
        action: String ->
      val encoded = NativeTerminalRegistry.encodeMouseEvent(
        sessionID,
        column,
        row,
        action
      )
      if (encoded != null) core.writeSession(sessionID, encoded)
      encoded != null
    }

    AsyncFunction("sendTerminalMouseScrollAsync") {
        sessionID: String,
        column: Int,
        row: Int,
        direction: String,
        steps: Int ->
      val encoded = NativeTerminalRegistry.encodeMouseScroll(
        sessionID,
        column,
        row,
        direction,
        steps
      )
      if (encoded != null) core.writeSession(sessionID, encoded)
      encoded != null
    }

    AsyncFunction("sendTerminalFocusAsync") { sessionID: String, focused: Boolean ->
      NativeTerminalRegistry.encodeFocus(sessionID, focused)
        ?.let { core.writeSession(sessionID, it) }
    }

    AsyncFunction("pasteSessionAsync") { sessionID: String, data: String ->
      NativeTerminalRegistry.encodePaste(sessionID, data)
        ?.let { core.writeSession(sessionID, it) }
    }

    AsyncFunction("resizeSessionAsync") { sessionID: String, columns: Int, rows: Int ->
      core.resizeSession(sessionID, columns.toLong(), rows.toLong())
    }

    AsyncFunction("pingSessionAsync") { sessionID: String ->
      core.pingSession(sessionID)
    }

    AsyncFunction("sessionOutputAsync") { sessionID: String, afterSequence: Double ->
      val output = core.sessionOutputJSON(sessionID, afterSequence.toLong())
      NativeTerminalRegistry.handleReplay(output)
      flushTerminalResponse(sessionID)
      JSONObject(output).apply {
        NativeTerminalRegistry.modes(sessionID)?.let { modes ->
          put("alternateScreen", modes.alternateScreen)
          put("mouseTracking", modes.mouseTracking)
          put("bracketedPaste", modes.bracketedPaste)
        }
      }.toString()
    }

    AsyncFunction("closeSessionAsync") { sessionID: String ->
      core.closeSession(sessionID)
      NativeTerminalRegistry.close(sessionID)
      appContext.reactContext?.let { context ->
        TerminalForegroundService.release(context, sessionID)
      }
    }
  }

  private suspend fun awaitNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

    val permissions = appContext.permissions
      ?: throw IllegalStateException("The Android permissions service is unavailable.")
    if (permissions.hasGrantedPermissions(Manifest.permission.POST_NOTIFICATIONS)) return

    suspendCancellableCoroutine { continuation ->
      permissions.askForPermissions(
        PermissionsResponseListener {
          if (continuation.isActive) continuation.resume(Unit)
        },
        Manifest.permission.POST_NOTIFICATIONS
      )
    }
  }

  private fun flushTerminalResponse(sessionId: String) {
    val response = NativeTerminalRegistry.takePtyWrite(sessionId) ?: return
    runCatching { core.writeSession(sessionId, response) }
  }
}

private fun JSONObject.toMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
  when (val value = get(key)) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    else -> value
  }
}
