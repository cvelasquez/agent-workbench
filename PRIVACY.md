# Privacy

This policy covers Agent Workbench: the app you run on your computer (the npm
package) and its Android app. Effective 2026-09-23.

**Agent Workbench collects nothing.** There are no accounts, no analytics, no
ads, no crash reports and no third-party SDKs. Neither the app nor its
maintainers receive any data from you.

## Where your data goes

- **The app on your computer** makes no network calls of its own. The CLIs it
  launches talk to their model providers exactly as they do in a plain
  terminal; that is between you and each provider, under their terms.
- **The Android app talks only to your own computer**, through an SSH tunnel
  on your network. It connects to no other server. The interface it shows is
  served by your computer, and what you type in it goes to your computer. A
  link to another site opens in your browser, not in the app.

## What the Android app keeps on the phone

All of it lives in the app's private storage, and it's deleted when you tap
**Settings → Forget this computer** or uninstall the app:

- How to reach your computer, as it came in the pairing code: its name, its
  network addresses, the SSH port, your user name on it and the app's port.
- Your computer's SSH fingerprint, saved at the first connection so the app can
  refuse a computer that isn't the one you paired.
- The phone's SSH key and the credential your computer gave it, **encrypted**
  with a key from the Android Keystore. The interface's cookie store also keeps
  the credential, as any browser does.
- Two settings: whether to show notices, and whether you left it connected.
- What the interface itself remembers, such as the theme or the language.

The app opts out of Android's cloud backup and device-to-device transfer, so
none of this is copied off the phone.

## Permissions the Android app asks for

| Permission | Why |
|---|---|
| Network access and network state | To reach your computer, and to reconnect when the Wi‑Fi comes back |
| Foreground service ("connected device") | To keep the tunnel open while the app isn't on screen. Android requires the permanent notification that comes with it |
| Change Wi‑Fi state | Android asks for one permission of this kind before it allows a "connected device" service. The app never changes your Wi‑Fi |
| Notifications | For "finished" and "is waiting for you" |
| Camera | Only to scan the pairing code. No picture is saved or sent |

It asks for nothing else: no location, contacts, microphone, phone or storage.
When you attach a file in the interface, Android's own file picker opens, and
only the file you pick is sent, to your computer.

## Children

Agent Workbench is a developer tool and isn't directed at children.

## Changes

Any change to this policy is published in this file, and its history is the
repository's history.

## Contact

Open an issue at
[github.com/cvelasquez/agent-workbench/issues](https://github.com/cvelasquez/agent-workbench/issues).
