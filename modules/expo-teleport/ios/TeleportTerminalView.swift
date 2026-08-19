import ExpoModulesCore
import os
import UIKit

private let terminalPerformanceLog = OSLog(
  subsystem: "com.naarang.telemob",
  category: .pointsOfInterest
)

final class GhosttyTerminalEngine {
  struct Modes {
    let alternateScreen: Bool
    let mouseTracking: Bool
    let bracketedPaste: Bool
  }

  struct Effects {
    let title: String?
    let bellCount: UInt32
  }

  private let lock = NSLock()
  private var handle: OpaquePointer?
  private var preparedSnapshot: Data?

  init?(columns: UInt16 = 84, rows: UInt16 = 40) {
    handle = telemob_terminal_create(columns, rows)
    if handle == nil { return nil }
  }

  deinit {
    close()
  }

  func reset() {
    locked {
      guard let handle else { return }
      telemob_terminal_reset(handle)
      preparedSnapshot = nil
    }
  }

  func write(_ data: Data) {
    guard !data.isEmpty else { return }
    os_signpost(.begin, log: terminalPerformanceLog, name: "Telemob.vtWrite")
    defer { os_signpost(.end, log: terminalPerformanceLog, name: "Telemob.vtWrite") }
    locked {
      guard let handle else { return }
      data.withUnsafeBytes { buffer in
        guard let base = buffer.bindMemory(to: UInt8.self).baseAddress else { return }
        telemob_terminal_write(handle, base, data.count)
      }
    }
  }

  func resize(columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    guard
      columns > 0, columns <= Int(UInt16.max),
      rows > 0, rows <= Int(UInt16.max)
    else { return }
    locked {
      guard let handle else { return }
      _ = telemob_terminal_resize(
        handle,
        UInt16(columns),
        UInt16(rows),
        UInt32(max(1, cellWidth)),
        UInt32(max(1, cellHeight))
      )
    }
  }

  func prepareSnapshot() -> Data? {
    os_signpost(.begin, log: terminalPerformanceLog, name: "Telemob.prepareSnapshot")
    defer { os_signpost(.end, log: terminalPerformanceLog, name: "Telemob.prepareSnapshot") }
    return locked { () -> Data? in
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_snapshot_bytes(handle, &bytes, &length), let bytes else {
        return preparedSnapshot
      }
      defer { telemob_terminal_bytes_free(bytes) }
      let next = Data(bytes: bytes, count: length)
      preparedSnapshot = next
      return next
    }
  }

  func snapshot() -> Data? { locked { preparedSnapshot } }

  func scroll(rows: Int) {
    guard rows != 0 else { return }
    locked {
      guard let handle else { return }
      telemob_terminal_scroll(handle, Int32(clamping: rows))
    }
  }

  func scrollToBottom() {
    locked {
      guard let handle else { return }
      telemob_terminal_scroll_to_bottom(handle)
    }
  }

  func select(
    startColumn: Int,
    startRow: Int,
    endColumn: Int,
    endRow: Int
  ) -> Bool {
    guard
      startColumn > 0, startColumn <= Int(UInt16.max),
      startRow > 0, startRow <= Int(UInt16.max),
      endColumn > 0, endColumn <= Int(UInt16.max),
      endRow > 0, endRow <= Int(UInt16.max)
    else { return false }
    return locked {
      guard let handle else { return false }
      return telemob_terminal_select(
        handle,
        UInt16(startColumn),
        UInt16(startRow),
        UInt16(endColumn),
        UInt16(endRow)
      )
    }
  }

  func clearSelection() {
    locked {
      guard let handle else { return }
      telemob_terminal_selection_clear(handle)
    }
  }

  func selectionText() -> String? {
    locked {
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_selection_text(handle, &bytes, &length), let bytes else {
        return nil
      }
      defer { telemob_terminal_bytes_free(bytes) }
      guard length > 0 else { return nil }
      return String(
        decoding: UnsafeBufferPointer(start: bytes, count: length),
        as: UTF8.self
      )
    }
  }

  func find(query: String, backwards: Bool) -> Bool {
    let data = Data(query.utf8)
    guard !data.isEmpty else { return false }
    return locked {
      guard let handle else { return false }
      return data.withUnsafeBytes { buffer in
        guard let base = buffer.bindMemory(to: UInt8.self).baseAddress else {
          return false
        }
        return telemob_terminal_find(handle, base, data.count, backwards)
      }
    }
  }

  func hyperlink(column: Int, row: Int) -> String? {
    guard
      column > 0, column <= Int(UInt16.max),
      row > 0, row <= Int(UInt16.max)
    else { return nil }
    return locked {
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_hyperlink(
        handle,
        UInt16(column),
        UInt16(row),
        &bytes,
        &length
      ), let bytes else { return nil }
      defer { telemob_terminal_bytes_free(bytes) }
      guard length > 0 else { return nil }
      return String(
        decoding: UnsafeBufferPointer(start: bytes, count: length),
        as: UTF8.self
      )
    }
  }

  func modes() -> Modes? {
    locked {
      guard let handle else { return nil }
      var alternateScreen = false
      var mouseTracking = false
      var bracketedPaste = false
      guard telemob_terminal_modes(
        handle,
        &alternateScreen,
        &mouseTracking,
        &bracketedPaste
      ) else { return nil }
      return Modes(
        alternateScreen: alternateScreen,
        mouseTracking: mouseTracking,
        bracketedPaste: bracketedPaste
      )
    }
  }

  func takePtyWrite() -> String? {
    locked {
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_take_pty_write(handle, &bytes, &length), let bytes else {
        return nil
      }
      defer { telemob_terminal_bytes_free(bytes) }
      guard length > 0 else { return nil }
      return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
    }
  }

  func takeEffects() -> Effects {
    locked {
      guard let handle else { return Effects(title: nil, bellCount: 0) }
      var titleBytes: UnsafeMutablePointer<UInt8>?
      var titleLength = 0
      let titleChanged = telemob_terminal_take_title(handle, &titleBytes, &titleLength)
      defer { telemob_terminal_bytes_free(titleBytes) }
      let title: String?
      if titleChanged {
        if let titleBytes, titleLength > 0 {
          title = String(
            decoding: UnsafeBufferPointer(start: titleBytes, count: titleLength),
            as: UTF8.self
          )
        } else {
          title = ""
        }
      } else {
        title = nil
      }
      return Effects(
        title: title,
        bellCount: telemob_terminal_take_bell_count(handle)
      )
    }
  }

  func encodeKey(key: Int32, text: String, modifiers: UInt16, action: Int32) -> String? {
    let input = Array(text.utf8)
    return locked {
      guard let handle else { return nil }
      return input.withUnsafeBytes { buffer in
        encodedBytes { output, length in
          telemob_terminal_encode_key(
            handle,
            key,
            buffer.bindMemory(to: UInt8.self).baseAddress,
            input.count,
            modifiers,
            action,
            output,
            length
          )
        }
      }
    }
  }

  func encodeMouse(
    action: Int32,
    button: Int32,
    modifiers: UInt16,
    column: Int,
    row: Int
  ) -> String? {
    guard column > 0, column <= Int(UInt16.max), row > 0, row <= Int(UInt16.max) else {
      return nil
    }
    return locked {
      guard let handle else { return nil }
      return encodedBytes { output, length in
        telemob_terminal_encode_mouse(
          handle,
          action,
          button,
          modifiers,
          UInt16(column),
          UInt16(row),
          output,
          length
        )
      }
    }
  }

  func encodeFocus(_ focused: Bool) -> String? {
    locked {
      guard let handle else { return nil }
      return encodedBytes { output, length in
        telemob_terminal_encode_focus(handle, focused, output, length)
      }
    }
  }

  func encodePaste(_ data: String) -> String? {
    let input = Array(data.utf8)
    return locked {
      guard let handle else { return nil }
      return input.withUnsafeBytes { buffer in
        encodedBytes { output, length in
          telemob_terminal_encode_paste(
            handle,
            buffer.bindMemory(to: UInt8.self).baseAddress,
            input.count,
            output,
            length
          )
        }
      }
    }
  }

  func close() {
    locked {
      guard let handle else { return }
      self.handle = nil
      telemob_terminal_destroy(handle)
    }
  }

  private func locked<Result>(_ operation: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return operation()
  }

  private func encodedBytes(
    _ operation: (
      UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
      UnsafeMutablePointer<Int>
    ) -> Bool
  ) -> String? {
    var bytes: UnsafeMutablePointer<UInt8>?
    var length = 0
    guard operation(&bytes, &length) else { return nil }
    guard length > 0, let bytes else { return nil }
    defer { telemob_terminal_bytes_free(bytes) }
    return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
  }
}

final class NativeTerminalRegistry {
  static let shared = NativeTerminalRegistry()

  private final class Session {
    let engine = GhosttyTerminalEngine()
    var lastSequence: Int64 = 0
    var pending: [Int64: Data] = [:]
    let views = NSHashTable<TeleportTerminalView>.weakObjects()
    var renderScheduled = false
  }

  private let lock = NSRecursiveLock()
  private let renderer = DispatchQueue(
    label: "com.naarang.telemob.terminal-renderer",
    qos: .userInteractive
  )
  private var sessions: [String: Session] = [:]
  private let keyCodes: [String: Int32] = {
    var result: [String: Int32] = [
      "text": 0, "interrupt": 1, "escape": 2, "tab": 3,
      "backspace": 4, "enter": 5, "insert": 6, "delete": 7,
      "pageup": 8, "pagedown": 9, "up": 10, "down": 11,
      "left": 12, "right": 13, "home": 14, "end": 15,
    ]
    for function in 1...12 { result["f\(function)"] = Int32(15 + function) }
    return result
  }()

  func prepare(sessionID: String) {
    guard !sessionID.isEmpty else { return }
    locked { _ = session(for: sessionID) }
  }

  func handle(event: [String: Any]) {
    guard let sessionID = event["sessionId"] as? String, !sessionID.isEmpty else { return }
    switch event["type"] as? String {
    case "data":
      let sequence = (event["sequence"] as? NSNumber)?.int64Value ?? 0
      if let value = event["data"] as? String, !value.isEmpty {
        feed(sessionID: sessionID, sequence: sequence, data: Data(value.utf8))
      }
    // Keep the final parsed frame after transport closure. The workspace
    // releases this parser explicitly when its terminal tab is disposed.
    case "closed":
      break
    default:
      break
    }
  }

  func handleData(sessionID: String, sequence: Int64, data: Data) {
    guard !sessionID.isEmpty, !data.isEmpty else { return }
    feed(sessionID: sessionID, sequence: sequence, data: data)
  }

  func handle(replayJSON: String) {
    guard
      let data = replayJSON.data(using: .utf8),
      let replay = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let sessionID = replay["sessionId"] as? String,
      let chunks = replay["chunks"] as? [[String: Any]]
    else { return }

    locked {
      guard let session = session(for: sessionID) else { return }
      if replay["truncated"] as? Bool == true,
        let first = chunks.first,
        let sequence = (first["sequence"] as? NSNumber)?.int64Value,
        sequence > session.lastSequence + 1
      {
        session.engine?.reset()
        session.pending.removeAll()
        session.lastSequence = sequence - 1
      }
      for chunk in chunks {
        let bytes: Data
        if let encoded = chunk["dataBase64"] as? String,
          let decoded = Data(base64Encoded: encoded)
        {
          bytes = decoded
        } else {
          bytes = Data((chunk["data"] as? String ?? "").utf8)
        }
        enqueue(
          session: session,
          sequence: (chunk["sequence"] as? NSNumber)?.int64Value ?? 0,
          data: bytes
        )
      }
      scheduleRender(session)
    }
  }

  func attach(sessionID: String, view: TeleportTerminalView) -> GhosttyTerminalEngine? {
    guard !sessionID.isEmpty else { return nil }
    return locked {
      guard let session = session(for: sessionID) else { return nil }
      session.views.add(view)
      scheduleRender(session)
      return session.engine
    }
  }

  func detach(sessionID: String, view: TeleportTerminalView) {
    locked { sessions[sessionID]?.views.remove(view) }
  }

  func resize(sessionID: String, columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.resize(
        columns: columns,
        rows: rows,
        cellWidth: cellWidth,
        cellHeight: cellHeight
      )
      scheduleRender(session)
    }
  }

  func scroll(sessionID: String, rows: Int) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.scroll(rows: rows)
      scheduleRender(session)
    }
  }

  func scrollToBottom(sessionID: String) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.scrollToBottom()
      scheduleRender(session)
    }
  }

  func select(
    sessionID: String,
    startColumn: Int,
    startRow: Int,
    endColumn: Int,
    endRow: Int
  ) -> Bool {
    locked {
      guard let session = sessions[sessionID] else { return false }
      let selected = session.engine?.select(
        startColumn: startColumn,
        startRow: startRow,
        endColumn: endColumn,
        endRow: endRow
      ) ?? false
      if selected { scheduleRender(session) }
      return selected
    }
  }

  func clearSelection(sessionID: String) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.clearSelection()
      scheduleRender(session)
    }
  }

  func selectionText(sessionID: String) -> String? {
    locked { sessions[sessionID]?.engine?.selectionText() }
  }

  func find(sessionID: String, query: String, backwards: Bool) -> Bool {
    locked {
      guard let session = sessions[sessionID] else { return false }
      let found = session.engine?.find(query: query, backwards: backwards) ?? false
      if found { scheduleRender(session) }
      return found
    }
  }

  func hyperlink(sessionID: String, column: Int, row: Int) -> String? {
    locked { sessions[sessionID]?.engine?.hyperlink(column: column, row: row) }
  }

  func modes(sessionID: String) -> GhosttyTerminalEngine.Modes? {
    locked { sessions[sessionID]?.engine?.modes() }
  }

  func takePtyWrite(sessionID: String) -> String? {
    locked { sessions[sessionID]?.engine?.takePtyWrite() }
  }

  func takeEffects(sessionID: String) -> GhosttyTerminalEngine.Effects? {
    locked { sessions[sessionID]?.engine?.takeEffects() }
  }

  func encodeKey(
    sessionID: String,
    key: String,
    text: String,
    ctrl: Bool,
    alt: Bool,
    shift: Bool,
    action: String
  ) -> String? {
    locked {
      guard let code = keyCodes[key.lowercased()] else { return nil }
      var modifiers: UInt16 = 0
      if shift { modifiers |= 1 }
      if ctrl { modifiers |= 2 }
      if alt { modifiers |= 4 }
      let actionCode: Int32 = action == "release" ? 0 : action == "repeat" ? 2 : 1
      return sessions[sessionID]?.engine?.encodeKey(
        key: code,
        text: text,
        modifiers: modifiers,
        action: actionCode
      )
    }
  }

  func encodeMouseTap(sessionID: String, column: Int, row: Int) -> String? {
    locked {
      guard let engine = sessions[sessionID]?.engine else { return nil }
      let press = engine.encodeMouse(
        action: 0, button: 1, modifiers: 0, column: column, row: row
      ) ?? ""
      let release = engine.encodeMouse(
        action: 1, button: 1, modifiers: 0, column: column, row: row
      ) ?? ""
      let result = press + release
      return result.isEmpty ? nil : result
    }
  }

  func encodeMouseEvent(
    sessionID: String,
    column: Int,
    row: Int,
    action: String
  ) -> String? {
    locked {
      guard let engine = sessions[sessionID]?.engine else { return nil }
      let actionCode: Int32
      switch action {
      case "press": actionCode = 0
      case "release": actionCode = 1
      case "motion": actionCode = 2
      default: return nil
      }
      return engine.encodeMouse(
        action: actionCode,
        button: 1,
        modifiers: 0,
        column: column,
        row: row
      )
    }
  }

  func encodeMouseScroll(
    sessionID: String,
    column: Int,
    row: Int,
    direction: String,
    steps: Int
  ) -> String? {
    locked {
      guard let engine = sessions[sessionID]?.engine else { return nil }
      let button: Int32 = direction == "up" ? 4 : 5
      let result = (0..<max(1, min(steps, 32))).reduce(into: "") { encoded, _ in
        encoded += engine.encodeMouse(
          action: 0,
          button: button,
          modifiers: 0,
          column: column,
          row: row
        ) ?? ""
      }
      return result.isEmpty ? nil : result
    }
  }

  func encodeFocus(sessionID: String, focused: Bool) -> String? {
    locked { sessions[sessionID]?.engine?.encodeFocus(focused) }
  }

  func encodePaste(sessionID: String, data: String) -> String? {
    locked { sessions[sessionID]?.engine?.encodePaste(data) }
  }

  func close(sessionID: String) {
    locked {
      guard let session = sessions.removeValue(forKey: sessionID) else { return }
      session.views.allObjects.forEach { $0.requestRender() }
      session.engine?.close()
    }
  }

  func closeAll() {
    locked {
      let existing = Array(sessions.values)
      sessions.removeAll()
      existing.forEach { session in
        session.views.allObjects.forEach { $0.requestRender() }
        session.engine?.close()
      }
    }
  }

  private func feed(sessionID: String, sequence: Int64, data: Data) {
    locked {
      guard let session = session(for: sessionID) else { return }
      enqueue(session: session, sequence: sequence, data: data)
      scheduleRender(session)
    }
  }

  private func session(for sessionID: String) -> Session? {
    if let session = sessions[sessionID] { return session }
    let created = Session()
    guard created.engine != nil else { return nil }
    sessions[sessionID] = created
    return created
  }

  private func enqueue(session: Session, sequence: Int64, data: Data) {
    guard sequence > session.lastSequence, !data.isEmpty else { return }
    session.pending[sequence] = data
    while let next = session.pending.removeValue(forKey: session.lastSequence + 1) {
      session.engine?.write(next)
      session.lastSequence += 1
    }
  }

  private func scheduleRender(_ session: Session) {
    guard !session.renderScheduled else { return }
    session.renderScheduled = true
    renderer.asyncAfter(deadline: .now() + .milliseconds(8)) { [weak self, weak session] in
      guard let self, let session else { return }
      self.locked {
        guard self.sessions.values.contains(where: { $0 === session }) else { return }
        session.renderScheduled = false
        _ = session.engine?.prepareSnapshot()
        session.views.allObjects.forEach { $0.requestRender() }
      }
    }
  }

  private func locked<Result>(_ operation: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return operation()
  }
}

public final class TeleportTerminalView: ExpoView {
  let onDimensions = EventDispatcher()

  var sessionID = "" {
    didSet {
      guard oldValue != sessionID else { return }
      NativeTerminalRegistry.shared.detach(sessionID: oldValue, view: self)
      engine = NativeTerminalRegistry.shared.attach(sessionID: sessionID, view: self)
      columns = 0
      rows = 0
      updateTerminalSize()
      requestRender()
    }
  }

  var fontSize: CGFloat = 12 {
    didSet {
      fontSize = min(32, max(6, fontSize))
      updateFontMetrics()
      updateTerminalSize()
      requestRender()
    }
  }

  private weak var engine: GhosttyTerminalEngine?
  private var font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
  private var boldFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)
  private var cellWidth: CGFloat = 1
  private var cellHeight: CGFloat = 1
  private var baselineOffset: CGFloat = 1
  private var columns = 0
  private var rows = 0
  private var blinkPhase = true
  private var blinkTimer: Timer?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isOpaque = true
    clipsToBounds = true
    contentMode = .redraw
    backgroundColor = UIColor(red: 11 / 255, green: 17 / 255, blue: 23 / 255, alpha: 1)
    updateFontMetrics()
  }

  deinit {
    blinkTimer?.invalidate()
    NativeTerminalRegistry.shared.detach(sessionID: sessionID, view: self)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    updateTerminalSize()
  }

  public override func draw(_ rect: CGRect) {
    guard let data = engine?.snapshot(), data.count >= snapshotHeaderSize else {
      UIColor(red: 11 / 255, green: 17 / 255, blue: 23 / 255, alpha: 1).setFill()
      UIRectFill(rect)
      return
    }

    data.withUnsafeBytes { rawBuffer in
      guard let bytes = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
      let snapshotColumns = readU16(bytes, 0)
      let snapshotRows = readU16(bytes, 2)
      let cursorColumn = readU16(bytes, 4)
      let cursorRow = readU16(bytes, 6)
      let cursorBlinking = bytes[16] != 0
      let cursorVisible = bytes[8] != 0 && (!cursorBlinking || blinkPhase)
      let cursorStyle = Int(bytes[9])
      let background = color(bytes, 10)
      let cursorColor = color(bytes, 17)
      let scrollbarTotal = readU64(bytes, 20)
      let scrollbarOffset = readU64(bytes, 28)
      let scrollbarLength = readU64(bytes, 36)
      var needsBlink = cursorBlinking && bytes[8] != 0
      background.setFill()
      UIRectFill(rect)

      let availableCells = (data.count - snapshotHeaderSize) / snapshotCellSize
      let cellCount = min(snapshotColumns * snapshotRows, availableCells)
      for index in 0..<cellCount {
        let offset = snapshotHeaderSize + index * snapshotCellSize
        let column = index % snapshotColumns
        let row = index / snapshotColumns
        let flags = readU16(bytes, offset + 6)
        if flags & flagBlink != 0 { needsBlink = true }
        var cellBackground = color(bytes, offset + 3)
        if flags & flagSelected != 0 { cellBackground = selectionBackground }
        let blockCursor = cursorVisible && cursorStyle == cursorBlock &&
          column == cursorColumn && row == cursorRow
        if blockCursor {
          cellBackground = cursorColor
        }

        let cellRect = CGRect(
          x: CGFloat(column) * cellWidth,
          y: CGFloat(row) * cellHeight,
          width: cellWidth,
          height: cellHeight
        )
        if cellBackground != background || blockCursor {
          cellBackground.setFill()
          UIRectFill(cellRect)
        }
      }

      drawTextRuns(
        bytes: bytes,
        dataCount: data.count,
        columns: snapshotColumns,
        rows: snapshotRows,
        cursorColumn: cursorColumn,
        cursorRow: cursorRow,
        cursorVisible: cursorVisible,
        cursorStyle: cursorStyle
      )

      if cursorVisible && cursorStyle != cursorBlock {
        drawCursor(
          column: cursorColumn,
          row: cursorRow,
          style: cursorStyle,
          color: cursorColor
        )
      }
      drawScrollbar(
        total: scrollbarTotal,
        offset: scrollbarOffset,
        length: scrollbarLength
      )
      updateBlinking(needsBlink)
    }
  }

  private func drawTextRuns(
    bytes: UnsafePointer<UInt8>,
    dataCount: Int,
    columns: Int,
    rows: Int,
    cursorColumn: Int,
    cursorRow: Int,
    cursorVisible: Bool,
    cursorStyle: Int
  ) {
    let availableCells = (dataCount - snapshotHeaderSize) / snapshotCellSize
    for row in 0..<rows {
      var runStart: Int?
      var runForeground = UIColor.white
      var runFlags = 0
      var runEnd = 0
      var runUnderlineStyle = 0
      var runUnderlineColor = UIColor.white
      var runText = ""

      func flush() {
        guard let start = runStart, !runText.isEmpty else { return }
        let baseFont = runFlags & flagBold != 0 ? boldFont : font
        var attributes: [NSAttributedString.Key: Any] = [
          .font: baseFont,
          .foregroundColor: runFlags & flagFaint != 0
            ? runForeground.withAlphaComponent(0.65)
            : runForeground,
        ]
        if runFlags & flagStrikethrough != 0 {
          attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        if runFlags & flagItalic != 0,
          let descriptor = baseFont.fontDescriptor.withSymbolicTraits(.traitItalic)
        {
          attributes[.font] = UIFont(descriptor: descriptor, size: fontSize)
        }
        (runText as NSString).draw(
          at: CGPoint(
            x: CGFloat(start) * cellWidth,
            y: CGFloat(row) * cellHeight + baselineOffset
          ),
          withAttributes: attributes
        )
        drawDecorations(
          row: row,
          startColumn: start,
          endColumn: runEnd,
          flags: runFlags,
          underlineStyle: runUnderlineStyle,
          underlineColor: runUnderlineColor
        )
        runStart = nil
        runText.removeAll(keepingCapacity: true)
      }

      for column in 0..<columns {
        let index = row * columns + column
        if index >= availableCells { break }
        let offset = snapshotHeaderSize + index * snapshotCellSize
        let flags = readU16(bytes, offset + 6)
        let textLength = min(Int(bytes[offset + 12]), terminalTextCapacity)
        let hidden = textLength == 0 || flags & flagInvisible != 0 ||
          (flags & flagBlink != 0 && !blinkPhase)
        if hidden {
          flush()
          continue
        }
        let blockCursor = cursorVisible && cursorStyle == cursorBlock &&
          column == cursorColumn && row == cursorRow
        let foreground: UIColor
        if blockCursor {
          foreground = color(bytes, offset + 3)
        } else if flags & flagSelected != 0 {
          foreground = selectionForeground
        } else {
          foreground = color(bytes, offset)
        }
        let styleFlags = flags & textStyleFlags
        let underlineStyle = Int(bytes[offset + 8])
        let underlineColor = color(bytes, offset + 9)
        if runStart != nil && (
          foreground != runForeground
            || styleFlags != runFlags
            || underlineStyle != runUnderlineStyle
            || underlineColor != runUnderlineColor
        ) {
          flush()
        }
        if runStart == nil {
          runStart = column
          runForeground = foreground
          runFlags = styleFlags
          runUnderlineStyle = underlineStyle
          runUnderlineColor = underlineColor
        }
        runText += String(
          decoding: UnsafeBufferPointer(start: bytes + offset + 13, count: textLength),
          as: UTF8.self
        )
        runEnd = column + 1
      }
      flush()
    }
  }

  private func drawDecorations(
    row: Int,
    startColumn: Int,
    endColumn: Int,
    flags: Int,
    underlineStyle: Int,
    underlineColor: UIColor
  ) {
    guard endColumn > startColumn else { return }
    let left = CGFloat(startColumn) * cellWidth
    let right = CGFloat(endColumn) * cellWidth
    let lineWidth = max(1 / contentScaleFactor, 1)
    if flags & flagUnderline != 0 {
      underlineColor.setStroke()
      let y = CGFloat(row) * cellHeight + baselineOffset + 1
      switch underlineStyle {
      case underlineDouble:
        for delta in [-lineWidth, lineWidth] {
          let path = UIBezierPath()
          path.lineWidth = lineWidth
          path.move(to: CGPoint(x: left, y: y + delta))
          path.addLine(to: CGPoint(x: right, y: y + delta))
          path.stroke()
        }
      case underlineCurly:
        let path = UIBezierPath()
        path.lineWidth = lineWidth
        path.move(to: CGPoint(x: left, y: y))
        let step = max(2, lineWidth * 2)
        var x = left
        var up = true
        while x < right {
          x = min(right, x + step)
          path.addLine(to: CGPoint(x: x, y: y + (up ? -lineWidth : lineWidth)))
          up.toggle()
        }
        path.stroke()
      case underlineDotted, underlineDashed:
        let path = UIBezierPath()
        path.lineWidth = lineWidth
        let pattern: [CGFloat] = underlineStyle == underlineDotted
          ? [lineWidth, lineWidth * 2]
          : [lineWidth * 4, lineWidth * 3]
        path.setLineDash(pattern, count: pattern.count, phase: 0)
        path.move(to: CGPoint(x: left, y: y))
        path.addLine(to: CGPoint(x: right, y: y))
        path.stroke()
      default:
        let path = UIBezierPath()
        path.lineWidth = lineWidth
        path.move(to: CGPoint(x: left, y: y))
        path.addLine(to: CGPoint(x: right, y: y))
        path.stroke()
      }
    }
    if flags & flagOverline != 0 {
      underlineColor.setStroke()
      let path = UIBezierPath()
      path.lineWidth = lineWidth
      let y = CGFloat(row) * cellHeight + lineWidth
      path.move(to: CGPoint(x: left, y: y))
      path.addLine(to: CGPoint(x: right, y: y))
      path.stroke()
    }
  }

  func requestRender() {
    DispatchQueue.main.async { [weak self] in
      self?.blinkPhase = true
      self?.setNeedsDisplay()
    }
  }

  private func updateBlinking(_ enabled: Bool) {
    if enabled == (blinkTimer != nil) { return }
    blinkTimer?.invalidate()
    blinkTimer = nil
    guard enabled else {
      blinkPhase = true
      return
    }
    blinkTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      guard let self else { return }
      blinkPhase.toggle()
      setNeedsDisplay()
    }
  }

  private func updateFontMetrics() {
    font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    boldFont = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
    cellWidth = max(1, ("M" as NSString).size(withAttributes: [.font: font]).width)
    cellHeight = max(1, ceil(font.lineHeight * 1.08))
    baselineOffset = max(0, (cellHeight - font.lineHeight) / 2)
  }

  private func updateTerminalSize() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let nextColumns = max(1, Int(floor(bounds.width / cellWidth)))
    let nextRows = max(1, Int(floor(bounds.height / cellHeight)))
    guard nextColumns != columns || nextRows != rows else { return }
    columns = nextColumns
    rows = nextRows
    if !sessionID.isEmpty {
      NativeTerminalRegistry.shared.resize(
        sessionID: sessionID,
        columns: columns,
        rows: rows,
        cellWidth: Int(ceil(cellWidth * contentScaleFactor)),
        cellHeight: Int(ceil(cellHeight * contentScaleFactor))
      )
    }
    onDimensions(["columns": columns, "rows": rows])
  }

  private func drawCursor(column: Int, row: Int, style: Int, color: UIColor) {
    var cursorRect = CGRect(
      x: CGFloat(column) * cellWidth,
      y: CGFloat(row) * cellHeight,
      width: cellWidth,
      height: cellHeight
    )
    color.setFill()
    color.setStroke()
    switch style {
    case cursorBar:
      cursorRect.size.width = 2 / contentScaleFactor
      UIRectFill(cursorRect)
    case cursorUnderline:
      cursorRect.origin.y = cursorRect.maxY - 2 / contentScaleFactor
      cursorRect.size.height = 2 / contentScaleFactor
      UIRectFill(cursorRect)
    default:
      UIRectFrame(cursorRect)
    }
  }

  private func drawScrollbar(total: UInt64, offset: UInt64, length: UInt64) {
    guard total > length, total > 0, length > 0, bounds.height > 0 else { return }
    let trackHeight = bounds.height
    let thumbHeight = min(
      trackHeight,
      max(20, trackHeight * CGFloat(length) / CGFloat(total))
    )
    let travel = trackHeight - thumbHeight
    let maximumOffset = max(UInt64(1), total - length)
    let top = travel * CGFloat(min(offset, maximumOffset)) / CGFloat(maximumOffset)
    let width = max(2 / contentScaleFactor, 2)
    selectionScrollbar.setFill()
    UIBezierPath(
      roundedRect: CGRect(
        x: bounds.width - width,
        y: top,
        width: width,
        height: thumbHeight
      ),
      cornerRadius: width / 2
    ).fill()
  }

  private func readU16(_ bytes: UnsafePointer<UInt8>, _ offset: Int) -> Int {
    Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
  }

  private func readU64(_ bytes: UnsafePointer<UInt8>, _ offset: Int) -> UInt64 {
    var result: UInt64 = 0
    for index in 0..<8 {
      result |= UInt64(bytes[offset + index]) << (index * 8)
    }
    return result
  }

  private func color(_ bytes: UnsafePointer<UInt8>, _ offset: Int) -> UIColor {
    UIColor(
      red: CGFloat(bytes[offset]) / 255,
      green: CGFloat(bytes[offset + 1]) / 255,
      blue: CGFloat(bytes[offset + 2]) / 255,
      alpha: 1
    )
  }

  private let snapshotHeaderSize = 44
  private let terminalTextCapacity = 64
  private let snapshotCellSize = 77
  private let cursorBar = 0
  private let cursorBlock = 1
  private let cursorUnderline = 2
  private let flagBold = 1 << 0
  private let flagItalic = 1 << 1
  private let flagFaint = 1 << 2
  private let flagBlink = 1 << 3
  private let flagInvisible = 1 << 5
  private let flagStrikethrough = 1 << 6
  private let flagUnderline = 1 << 7
  private let flagSelected = 1 << 9
  private let flagOverline = 1 << 8
  private let selectionBackground = UIColor(
    red: 49 / 255,
    green: 91 / 255,
    blue: 112 / 255,
    alpha: 1
  )
  private let selectionForeground = UIColor(
    red: 244 / 255,
    green: 251 / 255,
    blue: 253 / 255,
    alpha: 1
  )
  private let selectionScrollbar = UIColor(
    red: 119 / 255,
    green: 203 / 255,
    blue: 181 / 255,
    alpha: 0.75
  )
  private var textStyleFlags: Int {
    flagBold | flagItalic | flagFaint | flagUnderline | flagStrikethrough | flagOverline
  }
  private let underlineDouble = 2
  private let underlineCurly = 3
  private let underlineDotted = 4
  private let underlineDashed = 5
}
