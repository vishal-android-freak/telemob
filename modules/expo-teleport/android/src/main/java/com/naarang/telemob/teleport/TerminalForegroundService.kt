package com.naarang.telemob.teleport

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class TerminalForegroundService : Service() {
  private var sessionID: String? = null

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Active terminal",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps an active Telemob SSH terminal connected"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startID: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val nextSessionID = intent.getStringExtra(EXTRA_SESSION_ID) ?: return START_NOT_STICKY
        sessionID = nextSessionID
        activeSessionID = nextSessionID
        showForegroundNotification(intent.getStringExtra(EXTRA_TARGET).orEmpty())
      }
      ACTION_DISCONNECT -> {
        sessionID?.let(TeleportCoreHolder.core::closeSession)
        stopTerminalService()
      }
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun showForegroundNotification(target: String) {
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
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        2,
        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val notification = notificationBuilder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("Telemob terminal active")
      .setContentText(target.ifBlank { "SSH connection is running" })
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(Notification.Action.Builder(null, "Disconnect", stopIntent).build())
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
    if (activeSessionID == sessionID) activeSessionID = null
    sessionID = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  companion object {
    private const val CHANNEL_ID = "telemob_terminal"
    private const val NOTIFICATION_ID = 2401
    private const val ACTION_START = "com.naarang.telemob.terminal.START"
    private const val ACTION_DISCONNECT = "com.naarang.telemob.terminal.DISCONNECT"
    private const val EXTRA_SESSION_ID = "session_id"
    private const val EXTRA_TARGET = "target"
    @Volatile private var activeSessionID: String? = null

    fun start(context: Context, sessionID: String, target: String) {
      val intent = Intent(context, TerminalForegroundService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_SESSION_ID, sessionID)
        .putExtra(EXTRA_TARGET, target)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun release(context: Context, sessionID: String) {
      if (activeSessionID == sessionID) {
        activeSessionID = null
        context.stopService(Intent(context, TerminalForegroundService::class.java))
      }
    }

    fun stop(context: Context) {
      activeSessionID = null
      context.stopService(Intent(context, TerminalForegroundService::class.java))
    }
  }
}
