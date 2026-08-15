package com.naarang.telemob.teleport

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.DashPathEffect
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

class TeleportTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  internal val onDimensions by EventDispatcher<Map<String, Int>>()

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
    typeface = Typeface.MONOSPACE
  }
  private var engine: GhosttyTerminalEngine? = null
  private var cellWidth = 1f
  private var cellHeight = 1f
  private var baselineOffset = 1f
  private var columns = 0
  private var rows = 0
  private var attached = false
  private var blinkPhase = true
  private var blinkScheduled = false
  private val blinkRunnable = object : Runnable {
    override fun run() {
      if (!attached || !blinkScheduled) return
      blinkPhase = !blinkPhase
      postInvalidateOnAnimation()
      postDelayed(this, cursorBlinkIntervalMs)
    }
  }

  internal var sessionId: String = ""
    set(value) {
      if (field == value) return
      if (attached) NativeTerminalRegistry.detach(field, this)
      field = value
      engine = if (attached) NativeTerminalRegistry.attach(value, this) else null
      columns = 0
      rows = 0
      updateTerminalSize(width, height)
      requestRender()
    }

  internal var fontSize: Float = 12f
    set(value) {
      field = value.coerceIn(6f, 32f)
      updateFontMetrics()
      updateTerminalSize(width, height)
      requestRender()
    }

  init {
    setWillNotDraw(false)
    isFocusable = false
    updateFontMetrics()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true
    engine = NativeTerminalRegistry.attach(sessionId, this)
    updateTerminalSize(width, height)
  }

  override fun onDetachedFromWindow() {
    NativeTerminalRegistry.detach(sessionId, this)
    engine = null
    attached = false
    stopBlinking()
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    clipBounds = Rect(0, 0, width, height)
    updateTerminalSize(width, height)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    // React Native may disable parent child-clipping to implement
    // `overflow: visible`. Canvas.drawColor() otherwise fills that expanded
    // clip and paints over sibling React views such as the terminal header.
    canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
    val snapshot = engine?.snapshot()
    if (snapshot == null || snapshot.size < snapshotHeaderSize) {
      drawViewBackground(canvas, terminalBackground)
      return
    }

    val snapshotColumns = readU16(snapshot, 0)
    val snapshotRows = readU16(snapshot, 2)
    val cursorColumn = readU16(snapshot, 4)
    val cursorRow = readU16(snapshot, 6)
    val cursorBlinking = snapshot[16].toInt() != 0
    val cursorVisible = snapshot[8].toInt() != 0 && (!cursorBlinking || blinkPhase)
    val cursorStyle = unsigned(snapshot[9])
    val background = color(snapshot, 10)
    val cursorColor = color(snapshot, 17)
    val scrollbarTotal = readU64(snapshot, 20)
    val scrollbarOffset = readU64(snapshot, 28)
    val scrollbarLength = readU64(snapshot, 36)
    var needsBlink = cursorBlinking && snapshot[8].toInt() != 0
    drawViewBackground(canvas, background)

    val maximumCells = (snapshot.size - snapshotHeaderSize) / snapshotCellSize
    val cellCount = minOf(snapshotColumns * snapshotRows, maximumCells)
    for (index in 0 until cellCount) {
      val offset = snapshotHeaderSize + index * snapshotCellSize
      val column = index % snapshotColumns
      val row = index / snapshotColumns
      val flags = readU16(snapshot, offset + 6)
      if (flags and flagBlink != 0) needsBlink = true
      val textLength = minOf(unsigned(snapshot[offset + 12]), terminalTextCapacity)
      var cellBackground = color(snapshot, offset + 3)
      if (flags and flagSelected != 0) cellBackground = selectionBackground
      val blockCursor = cursorVisible && cursorStyle == cursorBlock &&
        column == cursorColumn && row == cursorRow
      if (blockCursor) {
        cellBackground = cursorColor
      }

      val left = column * cellWidth
      val top = row * cellHeight
      if (cellBackground != background || blockCursor) {
        paint.color = cellBackground
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paint)
      }
    }

    drawTextRuns(
      canvas,
      snapshot,
      snapshotColumns,
      snapshotRows,
      cellCount,
      cursorColumn,
      cursorRow,
      cursorVisible,
      cursorStyle
    )

    paint.alpha = 255
    paint.isFakeBoldText = false
    paint.textSkewX = 0f
    paint.isUnderlineText = false
    paint.isStrikeThruText = false
    if (cursorVisible && cursorStyle != cursorBlock) {
      drawCursor(canvas, cursorColumn, cursorRow, cursorStyle, cursorColor)
    }
    drawScrollbar(canvas, scrollbarTotal, scrollbarOffset, scrollbarLength)
    updateBlinking(needsBlink)
  }

  private fun drawTextRuns(
    canvas: Canvas,
    snapshot: ByteArray,
    snapshotColumns: Int,
    snapshotRows: Int,
    cellCount: Int,
    cursorColumn: Int,
    cursorRow: Int,
    cursorVisible: Boolean,
    cursorStyle: Int
  ) {
    for (row in 0 until snapshotRows) {
      var runStart = -1
      var runForeground = 0
      var runFlags = 0
      var runEnd = -1
      var runUnderlineStyle = 0
      var runUnderlineColor = 0
      val text = StringBuilder()

      fun flush() {
        if (runStart < 0 || text.isEmpty()) return
        paint.color = runForeground
        paint.alpha = if (runFlags and flagFaint != 0) 166 else 255
        paint.style = Paint.Style.FILL
        paint.isFakeBoldText = runFlags and flagBold != 0
        paint.textSkewX = if (runFlags and flagItalic != 0) -0.2f else 0f
        paint.isUnderlineText = false
        paint.isStrikeThruText = runFlags and flagStrikethrough != 0
        canvas.drawText(
          text.toString(),
          runStart * cellWidth,
          row * cellHeight + baselineOffset,
          paint
        )
        drawDecorations(
          canvas,
          row,
          runStart,
          runEnd,
          runFlags,
          runUnderlineStyle,
          runUnderlineColor
        )
        runStart = -1
        runEnd = -1
        text.clear()
      }

      for (column in 0 until snapshotColumns) {
        val index = row * snapshotColumns + column
        if (index >= cellCount) break
        val offset = snapshotHeaderSize + index * snapshotCellSize
        val flags = readU16(snapshot, offset + 6)
        val textLength = minOf(unsigned(snapshot[offset + 12]), terminalTextCapacity)
        val hidden = textLength == 0 || flags and flagInvisible != 0 ||
          (flags and flagBlink != 0 && !blinkPhase)
        if (hidden) {
          flush()
          continue
        }
        val blockCursor = cursorVisible && cursorStyle == cursorBlock &&
          column == cursorColumn && row == cursorRow
        val foreground = when {
          blockCursor -> color(snapshot, offset + 3)
          flags and flagSelected != 0 -> selectionForeground
          else -> color(snapshot, offset)
        }
        val styleFlags = flags and textStyleFlags
        val underlineStyle = unsigned(snapshot[offset + 8])
        val underlineColor = color(snapshot, offset + 9)
        if (runStart >= 0 && (
          foreground != runForeground
            || styleFlags != runFlags
            || underlineStyle != runUnderlineStyle
            || underlineColor != runUnderlineColor
        )) flush()
        if (runStart < 0) {
          runStart = column
          runForeground = foreground
          runFlags = styleFlags
          runUnderlineStyle = underlineStyle
          runUnderlineColor = underlineColor
        }
        text.append(String(snapshot, offset + 13, textLength, Charsets.UTF_8))
        runEnd = column + 1
      }
      flush()
    }
  }

  private fun drawDecorations(
    canvas: Canvas,
    row: Int,
    startColumn: Int,
    endColumn: Int,
    flags: Int,
    underlineStyle: Int,
    underlineColor: Int
  ) {
    if (startColumn < 0 || endColumn <= startColumn) return
    val left = startColumn * cellWidth
    val right = endColumn * cellWidth
    val density = resources.displayMetrics.density
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = max(1f, density)
    paint.pathEffect = null
    if (flags and flagUnderline != 0) {
      paint.color = underlineColor
      val y = row * cellHeight + baselineOffset + max(1f, density)
      when (underlineStyle) {
        underlineDouble -> {
          canvas.drawLine(left, y - density, right, y - density, paint)
          canvas.drawLine(left, y + density, right, y + density, paint)
        }
        underlineCurly -> {
          val path = Path()
          val step = max(2f, density * 2f)
          path.moveTo(left, y)
          var x = left
          var up = true
          while (x < right) {
            x = minOf(right, x + step)
            path.lineTo(x, y + if (up) -density else density)
            up = !up
          }
          canvas.drawPath(path, paint)
        }
        underlineDotted -> {
          paint.pathEffect = DashPathEffect(floatArrayOf(density, density * 2f), 0f)
          canvas.drawLine(left, y, right, y, paint)
        }
        underlineDashed -> {
          paint.pathEffect = DashPathEffect(floatArrayOf(density * 4f, density * 3f), 0f)
          canvas.drawLine(left, y, right, y, paint)
        }
        else -> canvas.drawLine(left, y, right, y, paint)
      }
    }
    paint.pathEffect = null
    if (flags and flagOverline != 0) {
      paint.color = underlineColor
      val y = row * cellHeight + max(1f, density)
      canvas.drawLine(left, y, right, y, paint)
    }
    paint.style = Paint.Style.FILL
  }

  internal fun requestRender() {
    blinkPhase = true
    postInvalidateOnAnimation()
  }

  private fun updateBlinking(enabled: Boolean) {
    if (enabled == blinkScheduled) return
    blinkScheduled = enabled
    removeCallbacks(blinkRunnable)
    if (enabled && attached) postDelayed(blinkRunnable, cursorBlinkIntervalMs)
  }

  private fun stopBlinking() {
    blinkScheduled = false
    blinkPhase = true
    removeCallbacks(blinkRunnable)
  }

  private fun drawViewBackground(canvas: Canvas, color: Int) {
    paint.color = color
    paint.alpha = 255
    paint.style = Paint.Style.FILL
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
  }

  private fun updateFontMetrics() {
    paint.textSize = fontSize * resources.displayMetrics.density
    paint.typeface = Typeface.MONOSPACE
    cellWidth = max(1f, paint.measureText("M"))
    val metrics = paint.fontMetrics
    val glyphHeight = metrics.descent - metrics.ascent
    cellHeight = max(1f, ceil(glyphHeight * 1.12f))
    baselineOffset = (cellHeight - glyphHeight) / 2f - metrics.ascent
  }

  private fun updateTerminalSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    val nextColumns = max(1, floor(width / cellWidth).toInt())
    val nextRows = max(1, floor(height / cellHeight).toInt())
    if (nextColumns == columns && nextRows == rows) return
    columns = nextColumns
    rows = nextRows
    if (sessionId.isNotBlank()) {
      NativeTerminalRegistry.resize(
        sessionId,
        columns,
        rows,
        ceil(cellWidth).toInt(),
        ceil(cellHeight).toInt()
      )
    }
    onDimensions(mapOf("columns" to columns, "rows" to rows))
  }

  private fun drawCursor(canvas: Canvas, column: Int, row: Int, style: Int, color: Int) {
    val left = column * cellWidth
    val top = row * cellHeight
    paint.color = color
    paint.alpha = 255
    when (style) {
      cursorBar -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top, left + max(2f, resources.displayMetrics.density), top + cellHeight, paint)
      }
      cursorUnderline -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top + cellHeight - max(2f, resources.displayMetrics.density), left + cellWidth, top + cellHeight, paint)
      }
      else -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(1f, resources.displayMetrics.density)
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paint)
        paint.style = Paint.Style.FILL
      }
    }
  }

  private fun drawScrollbar(canvas: Canvas, total: Long, offset: Long, length: Long) {
    if (total <= length || total <= 0L || length <= 0L || height <= 0) return
    val trackHeight = height.toFloat()
    val thumbHeight = max(20f * resources.displayMetrics.density, trackHeight * length / total)
      .coerceAtMost(trackHeight)
    val travel = trackHeight - thumbHeight
    val maximumOffset = max(1L, total - length)
    val top = travel * offset.coerceIn(0L, maximumOffset) / maximumOffset
    val width = max(2f, resources.displayMetrics.density * 2f)
    paint.color = scrollbarColor
    paint.alpha = 190
    paint.style = Paint.Style.FILL
    canvas.drawRoundRect(this.width - width, top, this.width.toFloat(), top + thumbHeight, width, width, paint)
    paint.alpha = 255
  }

  private fun readU16(data: ByteArray, offset: Int): Int =
    unsigned(data[offset]) or (unsigned(data[offset + 1]) shl 8)

  private fun readU64(data: ByteArray, offset: Int): Long {
    var result = 0L
    for (index in 0 until 8) {
      result = result or (unsigned(data[offset + index]).toLong() shl (index * 8))
    }
    return result
  }

  private fun color(data: ByteArray, offset: Int): Int = Color.rgb(
    unsigned(data[offset]),
    unsigned(data[offset + 1]),
    unsigned(data[offset + 2])
  )

  private fun unsigned(value: Byte): Int = value.toInt() and 0xff

  private companion object {
    const val snapshotHeaderSize = 44
    const val terminalTextCapacity = 64
    const val snapshotCellSize = 13 + terminalTextCapacity
    const val terminalBackground = 0xff0b1117.toInt()
    const val cursorBar = 0
    const val cursorBlock = 1
    const val cursorUnderline = 2
    const val flagBold = 1 shl 0
    const val flagItalic = 1 shl 1
    const val flagFaint = 1 shl 2
    const val flagBlink = 1 shl 3
    const val flagInvisible = 1 shl 5
    const val flagStrikethrough = 1 shl 6
    const val flagUnderline = 1 shl 7
    const val flagSelected = 1 shl 9
    const val flagOverline = 1 shl 8
    const val textStyleFlags = flagBold or flagItalic or flagFaint or flagUnderline or
      flagStrikethrough or flagOverline
    const val cursorBlinkIntervalMs = 500L
    const val selectionBackground = 0xff315b70.toInt()
    const val selectionForeground = 0xfff4fbfd.toInt()
    const val scrollbarColor = 0xff77cbb5.toInt()
    const val underlineDouble = 2
    const val underlineCurly = 3
    const val underlineDotted = 4
    const val underlineDashed = 5
  }
}
