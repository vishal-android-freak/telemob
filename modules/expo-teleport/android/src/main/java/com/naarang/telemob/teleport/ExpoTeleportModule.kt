package com.naarang.telemob.teleport

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import teleportmobile.EventSink

class ExpoTeleportModule : Module() {
  private val core by lazy { TeleportCoreHolder.core }
  private val passkeyRequests = mutableMapOf<String, String>()
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
      passkeyRequests.clear()
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
      passkeyRequests.clear()
    }

    AsyncFunction("beginLoginAsync") { requestJSON: String ->
      core.beginLoginJSON(requestJSON).also { challengeJSON ->
        val challenge = JSONObject(challengeJSON)
        if (challenge.optString("kind") == "passkey") {
          passkeyRequests[challenge.getString("challengeId")] = challenge.getString("requestJson")
        }
      }
    }

    AsyncFunction("finishTotpAsync") { challengeID: String, code: String ->
      core.finishTOTP(challengeID, code)
    }

    AsyncFunction("finishPasskeyAsync") Coroutine { challengeID: String, credentialJSON: String ->
      val assertionJSON = credentialJSON.ifBlank {
        val requestJSON = passkeyRequests[challengeID]
          ?: throw IllegalStateException("The passkey challenge is missing or expired.")
        val activity = appContext.currentActivity
          ?: throw IllegalStateException("The app must be visible to request a passkey.")
        val credentialManager = CredentialManager.create(activity)
        val response = credentialManager.getCredential(
          context = activity,
          request = GetCredentialRequest.Builder()
            .addCredentialOption(GetPublicKeyCredentialOption(requestJSON))
            .build()
        )
        val credential = response.credential as? PublicKeyCredential
          ?: throw IllegalStateException("The selected credential is not a passkey.")
        credential.authenticationResponseJson
      }
      core.finishPasskey(challengeID, assertionJSON).also {
        passkeyRequests.remove(challengeID)
      }
    }

    AsyncFunction("listServersAsync") {
      core.listServersJSON()
    }

    AsyncFunction("openSessionAsync") { targetJSON: String ->
      core.openSessionJSON(targetJSON).also { sessionJSON ->
        val session = JSONObject(sessionJSON)
        val target = JSONObject(targetJSON)
        if (
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
          && appContext.currentActivity?.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
          appContext.currentActivity?.requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            2402
          )
        }
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
