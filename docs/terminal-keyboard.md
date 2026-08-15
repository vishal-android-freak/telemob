# Terminal keyboard and touch input

> Telemob is an unofficial, independent client and has no affiliation with
> Gravitational Inc. or the Teleport project.

Telemob keeps the terminal full screen and uses the phone's native keyboard for
direct input. A horizontally scrollable utility rail exposes keys that mobile
keyboards usually omit.

## References

- [Termux extra keys](https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysInfo.java)
  demonstrates a compact terminal rail containing modifiers, escape, tab,
  navigation, paging, and macros.
- [Blink Shell](https://github.com/blinksh/blink) demonstrates a full-screen
  terminal with a dedicated mobile SmartKeys surface.
- [ConnectBot](https://github.com/connectbot/connectbot) reinforces that
  navigation and editing keys belong in the terminal input surface rather than
  an app-specific command language.

These projects informed the interaction model only. Telemob uses its own Expo
module around `libghostty-vt` and native Android/iOS drawing surfaces.

## Current key rail

The rail includes:

- one-shot `CTRL` and `ALT` modifiers;
- paste and optional whole-line input;
- `Ctrl+C`, `ESC`, and `TAB`;
- arrow, `HOME`, `END`, `PGUP`, and `PGDN` keys;
- `INSERT`, `DELETE`, and `BACKSPACE`;
- `F1` through `F12`.

Ctrl and Alt apply to the next character or utility key and then release. This
matches prefix-driven tools: tapping `CTRL`, typing `b`, and then typing `q`
sends `Ctrl+B` followed by plain `q`.

Navigation and function keys use standard CSI modifier parameters.
Paste uses bracketed paste when the remote terminal has enabled it.

## Direct input and line mode

Normal mode focuses an invisible native `TextInput`. Characters are sent to the
PTY immediately and appear where the remote application echoes them. Android's
keyboard is kept open after Return, while back-button dismissal releases focus
so one later terminal tap can reopen it.

Line mode is optional. It provides a visible mobile text field for composing a
long command before sending it with Return. It is not a second terminal buffer
and should not be used for interactive full-screen applications.

## Mouse-aware terminal applications

When the remote application enables terminal mouse tracking, Telemob translates a
tap into an SGR button press/release at the touched terminal cell. A vertical
swipe becomes repeated SGR wheel events. This supports buttons and scrolling in
compatible TUIs without turning every terminal touch into remote input.

When mouse tracking is disabled, swipes scroll Telemob's local terminal history
and taps can focus the keyboard. Terminal coordinates are calculated from the
same measured cell grid used to size the remote PTY.

## Future work

Custom key layouts, user-defined macros, hardware-keyboard shortcut discovery,
selection/copy gestures, and richer multi-touch handling remain future work.
