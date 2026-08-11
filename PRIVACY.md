# Privacy Policy — Session Recorder

**Summary: everything stays on your computer. This extension transmits
nothing, anywhere, ever.**

## What the extension does with data

- Session Recorder captures browsing data of the tab **you explicitly select**
  and only **while you have started a recording**: network requests and
  responses, screenshots, rendered-DOM snapshots, navigation events and user
  interactions (clicked elements — never keystrokes or typed text).
- All captured data is written **exclusively to a local folder that you pick**
  on your own machine. The extension has no server, no telemetry, no
  analytics, no remote logging, and makes no network requests of its own.
- Recording stops when you press Stop, close the recorded tab, or cancel the
  debugger prompt. Nothing is captured outside an active recording.

## What the extension deliberately does NOT capture

- Keystrokes or the content of text inputs while typing (form data appears in
  a recording only if the page submits it as a network request).
- Traffic of any tab other than the one selected for recording.
- Anything while recording is paused or stopped.

## Your responsibility as the person recording

Recordings can contain sensitive material from the sites you record: cookies,
session tokens, authentication headers, personal data shown on pages, and
submitted form data. Treat recorded session folders like confidential files:
store them appropriately, share them deliberately, and prefer test accounts /
test data when recording applications that process real personal data.

## Permissions used

- `debugger` — required to capture network response bodies and screenshots
  via the Chrome DevTools Protocol. Chrome displays a notice bar while it is
  active.
- `tabs` — required to list open tabs so you can choose which one to record.
- `sidePanel` — hosts the recorder's controls.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
