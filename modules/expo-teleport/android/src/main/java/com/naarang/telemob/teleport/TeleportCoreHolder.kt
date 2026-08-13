package com.naarang.telemob.teleport

import teleportmobile.Core
import teleportmobile.Teleportmobile

internal object TeleportCoreHolder {
  val core: Core by lazy { Teleportmobile.newCore() }
}
