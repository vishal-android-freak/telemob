# Terminal keyboard rationale

Telemob's touch key rail is based on the shared core of established mobile
terminal interfaces, while keeping the terminal itself full screen.

## References

- [Termux extra keys](https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysInfo.java)
  uses `ESC`, `TAB`, `CTRL`, `ALT`, arrows, `HOME`, `END`, `PGUP`, and `PGDN`
  as its representative two-row layout. It also supports literal keys and
  macros, confirming that a touch rail should send terminal input rather than
  operate an app-specific command layer.
- [Blink Shell](https://github.com/blinksh/blink) keeps the terminal full screen
  and documents Ctrl and Alt in its SmartKeys bar as continuous modifiers.
  Telemob follows that sticky-modifier behavior: tap the modifier again to
  release it.
- [ConnectBot](https://github.com/connectbot/connectbot) is an established
  native Android SSH terminal and reinforces that navigation/editing support
  belongs in the terminal input surface, not a separate command form.

## Telemob v1 rail

The always-available rail provides sticky `CTRL` and `ALT`, paste, optional
whole-line input, `Ctrl+C`, `ESC`, `TAB`, four arrows, `HOME`, `END`, `PGUP`,
`PGDN`, `INSERT`, `DELETE`, `BACKSPACE`, and `F1` through `F12`.

The normal mode is direct terminal input through an invisible native text
input. The visible whole-line form is optional because it is useful for long
commands on a phone, but it is not the primary input model. Escape sequences
include xterm modifier parameters so combinations such as Ctrl+Arrow and
Alt+Function remain meaningful to remote applications.

Macros, custom layouts, hardware-keyboard shortcuts, and swipe/popup keys are
deliberately future work. They require a settings and discoverability design;
hard-coding application-specific macros would not improve the general SSH
terminal experience.
