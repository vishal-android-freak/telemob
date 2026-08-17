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
        "Active connections",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps active Telemob SSH terminals and port forwards connected"
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
        if (connectionCount() == 0) stopTerminalService() else showForegroundNotification()
      }
      ACTION_START_FORWARD -> {
        val forwardID = intent.getStringExtra(EXTRA_FORWARD_ID) ?: return START_NOT_STICKY
        registerForward(forwardID, intent.getStringExtra(EXTRA_TARGET).orEmpty())
        showForegroundNotification()
      }
      ACTION_DISCONNECT -> {
        val sessions = sessionSnapshot()
        sessions.keys.forEach(TeleportCoreHolder.core::closeSession)
        sessions.keys.forEach(NativeTerminalRegistry::close)
        TeleportCoreHolder.core.stopAllLocalForwards()
        clearSessions()
        clearForwards()
        stopTerminalService()
      }
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun showForegroundNotification() {
    val sessions = sessionSnapshot()
    val forwards = forwardSnapshot()
    if (sessions.isEmpty() && forwards.isEmpty()) {
      stopTerminalService()
      return
    }
    val activeTerminal = sessions.values.lastOrNull()
    val activeForward = forwards.values.lastOrNull()
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
    val contentIntent = activeTerminal?.tabID?.takeIf(String::isNotBlank)?.let { tabID ->
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
    val count = sessions.size + forwards.size
    val title = if (count == 1) "Telemob connection active" else "$count Telemob connections active"
    val detail = if (count == 1 && activeTerminal != null) {
      activeTerminal.target.ifBlank { "SSH connection is running" }
    } else if (count == 1 && activeForward != null) {
      activeForward.target.ifBlank { "Port forwarding is running" }
    } else {
      "${sessions.size} terminals · ${forwards.size} port forwards"
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
    private data class ActiveForward(val target: String)

    private const val CHANNEL_ID = "telemob_terminal"
    private const val NOTIFICATION_ID = 2401
    private const val ACTION_START = "com.naarang.telemob.terminal.START"
    private const val ACTION_UPDATE = "com.naarang.telemob.terminal.UPDATE"
    private const val ACTION_START_FORWARD = "com.naarang.telemob.forward.START"
    private const val ACTION_DISCONNECT = "com.naarang.telemob.terminal.DISCONNECT"
    private const val EXTRA_SESSION_ID = "session_id"
    private const val EXTRA_TARGET = "target"
    private const val EXTRA_TAB_ID = "tab_id"
    private const val EXTRA_FORWARD_ID = "forward_id"
    private val activeSessions = linkedMapOf<String, ActiveTerminal>()
    private val activeForwards = linkedMapOf<String, ActiveForward>()

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
      if (connectionCount() == 0) {
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
      clearForwards()
      context.stopService(Intent(context, TerminalForegroundService::class.java))
    }

    fun startForward(context: Context, forwardID: String, target: String) {
      dispatch(
        context,
        Intent(context, TerminalForegroundService::class.java)
          .setAction(ACTION_START_FORWARD)
          .putExtra(EXTRA_FORWARD_ID, forwardID)
          .putExtra(EXTRA_TARGET, target)
      )
    }

    fun releaseForward(context: Context, forwardID: String) {
      synchronized(activeForwards) { activeForwards.remove(forwardID) }
      if (connectionCount() == 0) {
        context.stopService(Intent(context, TerminalForegroundService::class.java))
      } else {
        dispatch(context, Intent(context, TerminalForegroundService::class.java).setAction(ACTION_UPDATE))
      }
    }

    fun releaseAllForwards(context: Context) {
      clearForwards()
      if (connectionCount() == 0) {
        context.stopService(Intent(context, TerminalForegroundService::class.java))
      } else {
        dispatch(context, Intent(context, TerminalForegroundService::class.java).setAction(ACTION_UPDATE))
      }
    }

    private fun register(sessionID: String, target: String, tabID: String) {
      synchronized(activeSessions) {
        activeSessions.remove(sessionID)
        activeSessions[sessionID] = ActiveTerminal(target, tabID)
      }
    }

    private fun sessionSnapshot(): LinkedHashMap<String, ActiveTerminal> =
      synchronized(activeSessions) { LinkedHashMap(activeSessions) }

    private fun registerForward(forwardID: String, target: String) {
      synchronized(activeForwards) {
        activeForwards.remove(forwardID)
        activeForwards[forwardID] = ActiveForward(target)
      }
    }

    private fun forwardSnapshot(): LinkedHashMap<String, ActiveForward> =
      synchronized(activeForwards) { LinkedHashMap(activeForwards) }

    private fun connectionCount(): Int = sessionSnapshot().size + forwardSnapshot().size

    private fun clearSessions() {
      synchronized(activeSessions) { activeSessions.clear() }
    }

    private fun clearForwards() {
      synchronized(activeForwards) { activeForwards.clear() }
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
