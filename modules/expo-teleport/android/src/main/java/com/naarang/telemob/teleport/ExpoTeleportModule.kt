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
    override fun onTerminalEvent(eventJSON: String) {
      val event = JSONObject(eventJSON)
      if (event.optString("type") == "closed") {
        appContext.reactContext?.let { context ->
          TerminalForegroundService.release(context, event.optString("sessionId"))
        }
      }
      sendEvent("onTerminalEvent", event.toMap())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoTeleport")

    Events("onTerminalEvent")

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

    AsyncFunction("listServersAsync") {
      core.listServersJSON()
    }

    AsyncFunction("openSessionAsync") Coroutine { targetJSON: String ->
      awaitNotificationPermission()
      core.openSessionJSON(targetJSON).also { sessionJSON ->
        val session = JSONObject(sessionJSON)
        val target = JSONObject(targetJSON)
        appContext.reactContext?.let { context ->
          TerminalForegroundService.start(
            context,
            session.getString("id"),
            "${target.optString("login")}@${target.optString("hostname")}"
          )
        }
      }
    }

    AsyncFunction("writeSessionAsync") { sessionID: String, data: String ->
      core.writeSession(sessionID, data)
    }

    AsyncFunction("resizeSessionAsync") { sessionID: String, columns: Int, rows: Int ->
      core.resizeSession(sessionID, columns.toLong(), rows.toLong())
    }

    AsyncFunction("pingSessionAsync") { sessionID: String ->
      core.pingSession(sessionID)
    }

    AsyncFunction("sessionOutputAsync") { sessionID: String, afterSequence: Double ->
      core.sessionOutputJSON(sessionID, afterSequence.toLong())
    }

    AsyncFunction("closeSessionAsync") { sessionID: String ->
      core.closeSession(sessionID)
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
}

private fun JSONObject.toMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
  when (val value = get(key)) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    else -> value
  }
}
