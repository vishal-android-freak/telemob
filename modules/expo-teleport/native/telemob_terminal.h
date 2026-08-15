#ifndef TELEMOB_TERMINAL_H
#define TELEMOB_TERMINAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TELEMOB_TERMINAL_CELL_TEXT_CAPACITY 64
#define TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE 44
#define TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE (13 + TELEMOB_TERMINAL_CELL_TEXT_CAPACITY)

typedef enum {
  TELEMOB_TERMINAL_CURSOR_BAR = 0,
  TELEMOB_TERMINAL_CURSOR_BLOCK = 1,
  TELEMOB_TERMINAL_CURSOR_UNDERLINE = 2,
  TELEMOB_TERMINAL_CURSOR_HOLLOW = 3,
} TelemobTerminalCursorStyle;

typedef enum {
  TELEMOB_TERMINAL_CELL_BOLD = 1 << 0,
  TELEMOB_TERMINAL_CELL_ITALIC = 1 << 1,
  TELEMOB_TERMINAL_CELL_FAINT = 1 << 2,
  TELEMOB_TERMINAL_CELL_BLINK = 1 << 3,
  TELEMOB_TERMINAL_CELL_INVERSE = 1 << 4,
  TELEMOB_TERMINAL_CELL_INVISIBLE = 1 << 5,
  TELEMOB_TERMINAL_CELL_STRIKETHROUGH = 1 << 6,
  TELEMOB_TERMINAL_CELL_UNDERLINE = 1 << 7,
  TELEMOB_TERMINAL_CELL_OVERLINE = 1 << 8,
  TELEMOB_TERMINAL_CELL_SELECTED = 1 << 9,
} TelemobTerminalCellFlags;

typedef struct {
  uint8_t foreground_red;
  uint8_t foreground_green;
  uint8_t foreground_blue;
  uint8_t background_red;
  uint8_t background_green;
  uint8_t background_blue;
  uint16_t flags;
  uint8_t underline_style;
  uint8_t underline_red;
  uint8_t underline_green;
  uint8_t underline_blue;
  uint8_t text_length;
  char text[TELEMOB_TERMINAL_CELL_TEXT_CAPACITY];
} TelemobTerminalCell;

typedef struct {
  uint16_t columns;
  uint16_t rows;
  uint16_t cursor_column;
  uint16_t cursor_row;
  uint8_t cursor_visible;
  uint8_t cursor_style;
  uint8_t cursor_blinking;
  uint8_t cursor_red;
  uint8_t cursor_green;
  uint8_t cursor_blue;
  uint8_t background_red;
  uint8_t background_green;
  uint8_t background_blue;
  uint8_t foreground_red;
  uint8_t foreground_green;
  uint8_t foreground_blue;
  uint64_t scrollbar_total;
  uint64_t scrollbar_offset;
  uint64_t scrollbar_length;
  size_t cell_count;
  TelemobTerminalCell* cells;
} TelemobTerminalSnapshot;

typedef struct TelemobTerminal TelemobTerminal;

typedef enum {
  TELEMOB_TERMINAL_KEY_TEXT = 0,
  TELEMOB_TERMINAL_KEY_INTERRUPT,
  TELEMOB_TERMINAL_KEY_ESCAPE,
  TELEMOB_TERMINAL_KEY_TAB,
  TELEMOB_TERMINAL_KEY_BACKSPACE,
  TELEMOB_TERMINAL_KEY_ENTER,
  TELEMOB_TERMINAL_KEY_INSERT,
  TELEMOB_TERMINAL_KEY_DELETE,
  TELEMOB_TERMINAL_KEY_PAGE_UP,
  TELEMOB_TERMINAL_KEY_PAGE_DOWN,
  TELEMOB_TERMINAL_KEY_ARROW_UP,
  TELEMOB_TERMINAL_KEY_ARROW_DOWN,
  TELEMOB_TERMINAL_KEY_ARROW_LEFT,
  TELEMOB_TERMINAL_KEY_ARROW_RIGHT,
  TELEMOB_TERMINAL_KEY_HOME,
  TELEMOB_TERMINAL_KEY_END,
  TELEMOB_TERMINAL_KEY_F1,
  TELEMOB_TERMINAL_KEY_F2,
  TELEMOB_TERMINAL_KEY_F3,
  TELEMOB_TERMINAL_KEY_F4,
  TELEMOB_TERMINAL_KEY_F5,
  TELEMOB_TERMINAL_KEY_F6,
  TELEMOB_TERMINAL_KEY_F7,
  TELEMOB_TERMINAL_KEY_F8,
  TELEMOB_TERMINAL_KEY_F9,
  TELEMOB_TERMINAL_KEY_F10,
  TELEMOB_TERMINAL_KEY_F11,
  TELEMOB_TERMINAL_KEY_F12,
} TelemobTerminalKey;

typedef enum {
  TELEMOB_TERMINAL_KEY_ACTION_RELEASE = 0,
  TELEMOB_TERMINAL_KEY_ACTION_PRESS = 1,
  TELEMOB_TERMINAL_KEY_ACTION_REPEAT = 2,
} TelemobTerminalKeyAction;

typedef enum {
  TELEMOB_TERMINAL_MOD_SHIFT = 1 << 0,
  TELEMOB_TERMINAL_MOD_CTRL = 1 << 1,
  TELEMOB_TERMINAL_MOD_ALT = 1 << 2,
  TELEMOB_TERMINAL_MOD_SUPER = 1 << 3,
} TelemobTerminalModifiers;

typedef enum {
  TELEMOB_TERMINAL_MOUSE_PRESS = 0,
  TELEMOB_TERMINAL_MOUSE_RELEASE = 1,
  TELEMOB_TERMINAL_MOUSE_MOTION = 2,
} TelemobTerminalMouseAction;

typedef enum {
  TELEMOB_TERMINAL_MOUSE_NONE = 0,
  TELEMOB_TERMINAL_MOUSE_LEFT = 1,
  TELEMOB_TERMINAL_MOUSE_RIGHT = 2,
  TELEMOB_TERMINAL_MOUSE_MIDDLE = 3,
  TELEMOB_TERMINAL_MOUSE_WHEEL_UP = 4,
  TELEMOB_TERMINAL_MOUSE_WHEEL_DOWN = 5,
} TelemobTerminalMouseButton;

TelemobTerminal* telemob_terminal_create(uint16_t columns, uint16_t rows);
void telemob_terminal_destroy(TelemobTerminal* terminal);
void telemob_terminal_reset(TelemobTerminal* terminal);
void telemob_terminal_write(TelemobTerminal* terminal, const uint8_t* bytes, size_t length);
bool telemob_terminal_resize(
    TelemobTerminal* terminal,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height);
bool telemob_terminal_snapshot(TelemobTerminal* terminal, TelemobTerminalSnapshot* snapshot);
void telemob_terminal_snapshot_free(TelemobTerminalSnapshot* snapshot);
bool telemob_terminal_snapshot_bytes(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
void telemob_terminal_bytes_free(uint8_t* bytes);
bool telemob_terminal_modes(
    TelemobTerminal* terminal,
    bool* alternate_screen,
    bool* mouse_tracking,
    bool* bracketed_paste);
bool telemob_terminal_take_pty_write(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
bool telemob_terminal_take_title(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
uint32_t telemob_terminal_take_bell_count(TelemobTerminal* terminal);
bool telemob_terminal_encode_key(
    TelemobTerminal* terminal,
    int32_t key,
    const uint8_t* text,
    size_t text_length,
    uint16_t modifiers,
    int32_t action,
    uint8_t** output,
    size_t* output_length);
bool telemob_terminal_encode_mouse(
    TelemobTerminal* terminal,
    int32_t action,
    int32_t button,
    uint16_t modifiers,
    uint16_t column,
    uint16_t row,
    uint8_t** output,
    size_t* output_length);
bool telemob_terminal_encode_focus(
    TelemobTerminal* terminal,
    bool focused,
    uint8_t** output,
    size_t* output_length);
bool telemob_terminal_encode_paste(
    TelemobTerminal* terminal,
    const uint8_t* data,
    size_t data_length,
    uint8_t** output,
    size_t* output_length);
void telemob_terminal_scroll(TelemobTerminal* terminal, int32_t rows);
void telemob_terminal_scroll_to_bottom(TelemobTerminal* terminal);
bool telemob_terminal_select(
    TelemobTerminal* terminal,
    uint16_t start_column,
    uint16_t start_row,
    uint16_t end_column,
    uint16_t end_row);
void telemob_terminal_selection_clear(TelemobTerminal* terminal);
bool telemob_terminal_selection_text(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
bool telemob_terminal_find(
    TelemobTerminal* terminal,
    const uint8_t* query,
    size_t query_length,
    bool backwards);
bool telemob_terminal_hyperlink(
    TelemobTerminal* terminal,
    uint16_t column,
    uint16_t row,
    uint8_t** output,
    size_t* output_length);

#ifdef __cplusplus
}
#endif

#endif
