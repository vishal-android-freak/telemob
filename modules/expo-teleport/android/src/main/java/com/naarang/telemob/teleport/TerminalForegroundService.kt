package com.naarang.telemob.teleport

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder

class TerminalForegroundService : Service() {
  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Active terminals",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps active Telemob SSH terminals connected"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startID: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val sessionID = intent.getStringExtra(EXTRA_SESSION_ID) ?: return START_NOT_STICKY
        register(
          sessionID,
          intent.getStringExtra(EXTRA_TARGET).orEmpty(),
          intent.getStringExtra(EXTRA_TAB_ID).orEmpty()
        )
        showForegroundNotification()
      }
      ACTION_UPDATE -> {
        if (sessionSnapshot().isEmpty()) stopTerminalService() else showForegroundNotification()
      }
      ACTION_DISCONNECT -> {
        val sessions = sessionSnapshot()
        sessions.keys.forEach(TeleportCoreHolder.core::closeSession)
        sessions.keys.forEach(NativeTerminalRegistry::close)
        clearSessions()
        stopTerminalService()
      }
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun showForegroundNotification() {
    val sessions = sessionSnapshot()
    if (sessions.isEmpty()) {
      stopTerminalService()
      return
    }
    val active = sessions.values.last()
    val stopIntent = PendingIntent.getService(
      this,
      1,
      Intent(this, TerminalForegroundService::class.java).setAction(ACTION_DISCONNECT),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notificationBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val contentIntent = active.tabID.takeIf(String::isNotBlank)?.let { tabID ->
      PendingIntent.getActivity(
        this,
        2,
        Intent(Intent.ACTION_VIEW, Uri.parse("telemob://terminal/${Uri.encode(tabID)}"))
          .setPackage(packageName)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } ?: packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
      PendingIntent.getActivity(
        this,
        2,
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val count = sessions.size
    val title = if (count == 1) "Telemob terminal active" else "$count Telemob terminals active"
    val detail = if (count == 1) {
      active.target.ifBlank { "SSH connection is running" }
    } else {
      "$count SSH sessions · ${active.target.ifBlank { "latest terminal" }}"
    }
    val actionLabel = if (count == 1) "Disconnect" else "Disconnect all"
    val notification = notificationBuilder
      .setSmallIcon(R.drawable.ic_telemob_terminal)
      .setContentTitle(title)
      .setContentText(detail)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(Notification.Action.Builder(null, actionLabel, stopIntent).build())
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
      }
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun stopTerminalService() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  companion object {
    private data class ActiveTerminal(val target: String, val tabID: String)

    private const val CHANNEL_ID = "telemob_terminal"
    private const val NOTIFICATION_ID = 2401
    private const val ACTION_START = "com.naarang.telemob.terminal.START"
    private const val ACTION_UPDATE = "com.naarang.telemob.terminal.UPDATE"
    private const val ACTION_DISCONNECT = "com.naarang.telemob.terminal.DISCONNECT"
    private const val EXTRA_SESSION_ID = "session_id"
    private const val EXTRA_TARGET = "target"
    private const val EXTRA_TAB_ID = "tab_id"
    private val activeSessions = linkedMapOf<String, ActiveTerminal>()

    fun start(context: Context, sessionID: String, target: String, tabID: String) {
      val intent = Intent(context, TerminalForegroundService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_SESSION_ID, sessionID)
        .putExtra(EXTRA_TARGET, target)
        .putExtra(EXTRA_TAB_ID, tabID)
      dispatch(context, intent)
    }

    fun release(context: Context, sessionID: String) {
      synchronized(activeSessions) { activeSessions.remove(sessionID) }
      if (sessionSnapshot().isEmpty()) {
        context.stopService(Intent(context, TerminalForegroundService::class.java))
      } else {
        dispatch(
          context,
          Intent(context, TerminalForegroundService::class.java).setAction(ACTION_UPDATE)
        )
      }
    }

    fun stop(context: Context) {
      clearSessions()
      context.stopService(Intent(context, TerminalForegroundService::class.java))
    }

    private fun register(sessionID: String, target: String, tabID: String) {
      synchronized(activeSessions) {
        activeSessions.remove(sessionID)
        activeSessions[sessionID] = ActiveTerminal(target, tabID)
      }
    }

    private fun sessionSnapshot(): LinkedHashMap<String, ActiveTerminal> =
      synchronized(activeSessions) { LinkedHashMap(activeSessions) }

    private fun clearSessions() {
      synchronized(activeSessions) { activeSessions.clear() }
    }

    private fun dispatch(context: Context, intent: Intent) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
