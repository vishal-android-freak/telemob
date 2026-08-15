#include "telemob_terminal.h"

#include <ghostty/vt.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

struct TelemobTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render_state;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  uint8_t* pty_write;
  size_t pty_write_length;
  size_t pty_write_capacity;
  pthread_mutex_t mutex;
};

static void on_write_pty(
    GhosttyTerminal terminal,
    void* userdata,
    const uint8_t* data,
    size_t length) {
  (void)terminal;
  TelemobTerminal* state = userdata;
  if (state == NULL || data == NULL || length == 0) return;
  if (length > SIZE_MAX - state->pty_write_length) return;
  const size_t required = state->pty_write_length + length;
  if (required > state->pty_write_capacity) {
    size_t capacity = state->pty_write_capacity == 0 ? 64 : state->pty_write_capacity;
    while (capacity < required && capacity <= SIZE_MAX / 2) capacity *= 2;
    if (capacity < required) capacity = required;
    uint8_t* resized = realloc(state->pty_write, capacity);
    if (resized == NULL) return;
    state->pty_write = resized;
    state->pty_write_capacity = capacity;
  }
  memcpy(state->pty_write + state->pty_write_length, data, length);
  state->pty_write_length = required;
}

static void clear_snapshot(TelemobTerminalSnapshot* snapshot) {
  if (snapshot != NULL) memset(snapshot, 0, sizeof(*snapshot));
}

static GhosttyColorRgb resolved_color(
    GhosttyStyleColor color,
    const GhosttyRenderStateColors* colors,
    GhosttyColorRgb fallback) {
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_RGB:
      return color.value.rgb;
    case GHOSTTY_STYLE_COLOR_PALETTE:
      return colors->palette[color.value.palette];
    default:
      return fallback;
  }
}

static size_t append_utf8(char* output, size_t capacity, uint32_t codepoint) {
  if (codepoint <= 0x7f && capacity >= 1) {
    output[0] = (char)codepoint;
    return 1;
  }
  if (codepoint <= 0x7ff && capacity >= 2) {
    output[0] = (char)(0xc0 | (codepoint >> 6));
    output[1] = (char)(0x80 | (codepoint & 0x3f));
    return 2;
  }
  if (codepoint <= 0xffff && capacity >= 3) {
    output[0] = (char)(0xe0 | (codepoint >> 12));
    output[1] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    output[2] = (char)(0x80 | (codepoint & 0x3f));
    return 3;
  }
  if (codepoint <= 0x10ffff && capacity >= 4) {
    output[0] = (char)(0xf0 | (codepoint >> 18));
    output[1] = (char)(0x80 | ((codepoint >> 12) & 0x3f));
    output[2] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    output[3] = (char)(0x80 | (codepoint & 0x3f));
    return 4;
  }
  return 0;
}

TelemobTerminal* telemob_terminal_create(uint16_t columns, uint16_t rows) {
  if (columns == 0 || rows == 0) return NULL;
  TelemobTerminal* result = calloc(1, sizeof(*result));
  if (result == NULL) return NULL;
  if (pthread_mutex_init(&result->mutex, NULL) != 0) {
    free(result);
    return NULL;
  }
  GhosttyTerminalOptions options = {
      .cols = columns,
      .rows = rows,
      .max_scrollback = 10000,
  };
  if (ghostty_terminal_new(NULL, &result->terminal, options) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &result->render_state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &result->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &result->cells) != GHOSTTY_SUCCESS) {
    telemob_terminal_destroy(result);
    return NULL;
  }
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_USERDATA,
      result);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      (const void*)on_write_pty);
  return result;
}

void telemob_terminal_destroy(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  if (terminal->cells != NULL) ghostty_render_state_row_cells_free(terminal->cells);
  if (terminal->rows != NULL) ghostty_render_state_row_iterator_free(terminal->rows);
  if (terminal->render_state != NULL) ghostty_render_state_free(terminal->render_state);
  if (terminal->terminal != NULL) ghostty_terminal_free(terminal->terminal);
  free(terminal->pty_write);
  pthread_mutex_destroy(&terminal->mutex);
  free(terminal);
}

void telemob_terminal_reset(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_terminal_reset(terminal->terminal);
  terminal->pty_write_length = 0;
  pthread_mutex_unlock(&terminal->mutex);
}

void telemob_terminal_write(TelemobTerminal* terminal, const uint8_t* bytes, size_t length) {
  if (terminal == NULL || bytes == NULL || length == 0) return;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_terminal_vt_write(terminal->terminal, bytes, length);
  pthread_mutex_unlock(&terminal->mutex);
}

bool telemob_terminal_resize(
    TelemobTerminal* terminal,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height) {
  if (terminal == NULL || columns == 0 || rows == 0) return false;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyResult result = ghostty_terminal_resize(
      terminal->terminal,
      columns,
      rows,
      cell_width,
      cell_height);
  pthread_mutex_unlock(&terminal->mutex);
  return result == GHOSTTY_SUCCESS;
}

static void fill_cell(
    GhosttyRenderStateRowCells cells,
    const GhosttyRenderStateColors* colors,
    TelemobTerminalCell* output) {
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  GhosttyColorRgb foreground = colors->foreground;
  GhosttyColorRgb background = colors->background;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
          &style) == GHOSTTY_SUCCESS) {
    foreground = resolved_color(style.fg_color, colors, foreground);
    background = resolved_color(style.bg_color, colors, background);
    if (style.bold) output->flags |= TELEMOB_TERMINAL_CELL_BOLD;
    if (style.italic) output->flags |= TELEMOB_TERMINAL_CELL_ITALIC;
    if (style.faint) output->flags |= TELEMOB_TERMINAL_CELL_FAINT;
    if (style.blink) output->flags |= TELEMOB_TERMINAL_CELL_BLINK;
    if (style.inverse) output->flags |= TELEMOB_TERMINAL_CELL_INVERSE;
    if (style.invisible) output->flags |= TELEMOB_TERMINAL_CELL_INVISIBLE;
    if (style.strikethrough) output->flags |= TELEMOB_TERMINAL_CELL_STRIKETHROUGH;
    if (style.underline != 0) output->flags |= TELEMOB_TERMINAL_CELL_UNDERLINE;
  }

  GhosttyColorRgb explicit_color;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
          &explicit_color) == GHOSTTY_SUCCESS) {
    foreground = explicit_color;
  }
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
          &explicit_color) == GHOSTTY_SUCCESS) {
    background = explicit_color;
  }
  if (style.inverse) {
    GhosttyColorRgb swap = foreground;
    foreground = background;
    background = swap;
  }
  output->foreground_red = foreground.r;
  output->foreground_green = foreground.g;
  output->foreground_blue = foreground.b;
  output->background_red = background.r;
  output->background_green = background.g;
  output->background_blue = background.b;

  uint32_t grapheme_length = 0;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
          &grapheme_length) != GHOSTTY_SUCCESS ||
      grapheme_length == 0) {
    return;
  }
  uint32_t stack_codepoints[16];
  uint32_t* codepoints = stack_codepoints;
  if (grapheme_length > 16) codepoints = calloc(grapheme_length, sizeof(*codepoints));
  if (codepoints == NULL) return;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
          codepoints) == GHOSTTY_SUCCESS) {
    size_t written = 0;
    for (uint32_t index = 0; index < grapheme_length; index += 1) {
      written += append_utf8(
          output->text + written,
          TELEMOB_TERMINAL_CELL_TEXT_CAPACITY - written,
          codepoints[index]);
      if (written >= TELEMOB_TERMINAL_CELL_TEXT_CAPACITY) break;
    }
    output->text_length = (uint8_t)written;
  }
  if (codepoints != stack_codepoints) free(codepoints);
}

bool telemob_terminal_snapshot(TelemobTerminal* terminal, TelemobTerminalSnapshot* snapshot) {
  if (terminal == NULL || snapshot == NULL) return false;
  clear_snapshot(snapshot);
  pthread_mutex_lock(&terminal->mutex);
  if (ghostty_render_state_update(terminal->render_state, terminal->terminal) != GHOSTTY_SUCCESS) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  if (ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_COLS,
          &snapshot->columns) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_ROWS,
          &snapshot->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_colors_get(terminal->render_state, &colors) != GHOSTTY_SUCCESS) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  snapshot->background_red = colors.background.r;
  snapshot->background_green = colors.background.g;
  snapshot->background_blue = colors.background.b;
  snapshot->foreground_red = colors.foreground.r;
  snapshot->foreground_green = colors.foreground.g;
  snapshot->foreground_blue = colors.foreground.b;
  snapshot->cell_count = (size_t)snapshot->columns * (size_t)snapshot->rows;
  snapshot->cells = calloc(snapshot->cell_count, sizeof(*snapshot->cells));
  if (snapshot->cells == NULL) {
    clear_snapshot(snapshot);
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  bool cursor_visible = false;
  bool cursor_in_viewport = false;
  GhosttyRenderStateCursorVisualStyle cursor_style = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
      &cursor_visible);
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
      &cursor_in_viewport);
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
      &cursor_style);
  snapshot->cursor_visible = cursor_visible && cursor_in_viewport;
  snapshot->cursor_style = (uint8_t)cursor_style;
  if (snapshot->cursor_visible) {
    ghostty_render_state_get(
        terminal->render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
        &snapshot->cursor_column);
    ghostty_render_state_get(
        terminal->render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
        &snapshot->cursor_row);
  }

  if (ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
          &terminal->rows) != GHOSTTY_SUCCESS) {
    telemob_terminal_snapshot_free(snapshot);
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  size_t row_index = 0;
  while (row_index < snapshot->rows && ghostty_render_state_row_iterator_next(terminal->rows)) {
    if (ghostty_render_state_row_get(
            terminal->rows,
            GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
            &terminal->cells) != GHOSTTY_SUCCESS) {
      break;
    }
    size_t column_index = 0;
    while (column_index < snapshot->columns && ghostty_render_state_row_cells_next(terminal->cells)) {
      fill_cell(
          terminal->cells,
          &colors,
          &snapshot->cells[row_index * snapshot->columns + column_index]);
      column_index += 1;
    }
    row_index += 1;
  }
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

void telemob_terminal_snapshot_free(TelemobTerminalSnapshot* snapshot) {
  if (snapshot == NULL) return;
  free(snapshot->cells);
  clear_snapshot(snapshot);
}

static void write_u16(uint8_t* output, uint16_t value) {
  output[0] = (uint8_t)(value & 0xff);
  output[1] = (uint8_t)((value >> 8) & 0xff);
}

bool telemob_terminal_snapshot_bytes(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;

  TelemobTerminalSnapshot snapshot;
  if (!telemob_terminal_snapshot(terminal, &snapshot)) return false;
  if (snapshot.cell_count >
      (SIZE_MAX - TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE) /
          TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE) {
    telemob_terminal_snapshot_free(&snapshot);
    return false;
  }

  const size_t length = TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE +
      snapshot.cell_count * TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE;
  uint8_t* bytes = calloc(length, 1);
  if (bytes == NULL) {
    telemob_terminal_snapshot_free(&snapshot);
    return false;
  }

  write_u16(bytes + 0, snapshot.columns);
  write_u16(bytes + 2, snapshot.rows);
  write_u16(bytes + 4, snapshot.cursor_column);
  write_u16(bytes + 6, snapshot.cursor_row);
  bytes[8] = snapshot.cursor_visible;
  bytes[9] = snapshot.cursor_style;
  bytes[10] = snapshot.background_red;
  bytes[11] = snapshot.background_green;
  bytes[12] = snapshot.background_blue;
  bytes[13] = snapshot.foreground_red;
  bytes[14] = snapshot.foreground_green;
  bytes[15] = snapshot.foreground_blue;

  for (size_t index = 0; index < snapshot.cell_count; index += 1) {
    const TelemobTerminalCell* cell = &snapshot.cells[index];
    uint8_t* target = bytes + TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE +
        index * TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE;
    target[0] = cell->foreground_red;
    target[1] = cell->foreground_green;
    target[2] = cell->foreground_blue;
    target[3] = cell->background_red;
    target[4] = cell->background_green;
    target[5] = cell->background_blue;
    target[6] = cell->flags;
    target[7] = cell->text_length;
    memcpy(target + 8, cell->text, cell->text_length);
  }

  telemob_terminal_snapshot_free(&snapshot);
  *output = bytes;
  *output_length = length;
  return true;
}

void telemob_terminal_bytes_free(uint8_t* bytes) {
  free(bytes);
}

bool telemob_terminal_modes(
    TelemobTerminal* terminal,
    bool* alternate_screen,
    bool* mouse_tracking,
    bool* bracketed_paste) {
  if (terminal == NULL || alternate_screen == NULL || mouse_tracking == NULL ||
      bracketed_paste == NULL) {
    return false;
  }
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  const bool success =
      ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
          &screen) == GHOSTTY_SUCCESS &&
      ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING,
          mouse_tracking) == GHOSTTY_SUCCESS &&
      ghostty_terminal_mode_get(
          terminal->terminal,
          GHOSTTY_MODE_BRACKETED_PASTE,
          bracketed_paste) == GHOSTTY_SUCCESS;
  *alternate_screen = screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE;
  pthread_mutex_unlock(&terminal->mutex);
  return success;
}

bool telemob_terminal_take_pty_write(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  if (terminal->pty_write_length == 0) {
    pthread_mutex_unlock(&terminal->mutex);
    return true;
  }
  *output = terminal->pty_write;
  *output_length = terminal->pty_write_length;
  terminal->pty_write = NULL;
  terminal->pty_write_length = 0;
  terminal->pty_write_capacity = 0;
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

void telemob_terminal_scroll(TelemobTerminal* terminal, int32_t rows) {
  if (terminal == NULL || rows == 0) return;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
      .value = {.delta = rows},
  };
  ghostty_terminal_scroll_viewport(terminal->terminal, behavior);
  pthread_mutex_unlock(&terminal->mutex);
}

void telemob_terminal_scroll_to_bottom(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM,
  };
  ghostty_terminal_scroll_viewport(terminal->terminal, behavior);
  pthread_mutex_unlock(&terminal->mutex);
}
