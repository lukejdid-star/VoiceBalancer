# VoiceBalancer

A BetterDiscord plugin that makes everyone in a voice channel arrive at the same volume.

One friend clips your headphones every time they laugh. Another is a whisper you can never quite hear. Discord gives you a per-user volume slider to fix this by hand, one person at a time, forever. VoiceBalancer does it for you.

---

## Status: plumbing proven live, tuning unfinished

Be honest with yourself before installing this: **the mechanism works, the tuning does not yet.**

What is verified, against a real Discord 1.0.9258 desktop client in a live call with seven people:

- Per-user audio levels are readable, and the plugin reads them correctly
- Volumes are writable, and the plugin writes them
- 30 seconds of continuous operation produced **zero** settings-sync API calls, so it does not hammer your account
- The settings panel renders, the source is selected, nothing throws

What is **not** finished is the tuning — the gates, targets and time constants that decide *how much* to move each person. Watching it run on a real call surfaced three genuine bugs in a row (documented below), each fixed, but the last fixes were never verified against live voices. Expect it to misbehave. Expect to need the **Restore volumes on disable** switch.

---

## How it reads levels

Discord exposes no public API for this, and the obvious approaches are dead ends on the desktop client:

- **No Web Audio tap.** Voice is decoded and played by the native engine. The renderer holds zero audio streams (`mediaEngineConnectionId: "Native-0"`), so there is nothing for JavaScript to process. This is also why a single compressor between you and the channel — the intuitive design — cannot be built as a plugin. There is no mixed stream to put it on.
- **No `VoiceActivity` event.** Discord's own client type definitions document `MediaEngine.on("VoiceActivity", (userId, level) => ...)`. On this build it never fires. Sniffing every event emitted by the engine and its connections during active speech produced `speaking`, `stats`, `outboundlossrate` and `connection-stats` — and no `VoiceActivity` at all. The plugin still tries it, in case other builds do emit it.

What actually works:

```js
(await connection.getStats()).rtp.inbound[userId][0].audioLevel
```

`rtp.inbound` is keyed by **user ID directly** — no SSRC mapping needed — and each entry carries a linear `audioLevel` plus `audioDetected`, Discord's own voice-activity flag. Measured live: `getStats()` costs ~1.25 ms and the level refreshes at roughly 8 Hz, so polling every 100 ms is cheap and loses nothing.

Levels are **pre-volume**, confirmed by experiment: halving every participant's local volume and comparing bucketed samples moved the measured level by a median of 0.4 dB, against −6.0 dB if it were post-volume.

---

## Two modes

**Level lock** (default) rides each person's gain in real time so every voice lands on the target, moment to moment. This is as close as a plugin can get to a compressor on the channel. It is per-user rather than one gate on the mix, which is actually an advantage: one gate cannot separate two people talking at once, and this can.

**Learn** instead settles on one volume per person from their average speaking level. Slower to react, much steadier, and it remembers people between sessions.

---

## Bugs the live call found

Worth reading, because they are the parts most likely still wrong.

**A deadzone is not hysteresis.** A flat 1.5 dB deadzone blocked the *finish* of every correction, not just the start, leaving everyone about 1.4 dB short. Replaced with 1.5 dB to start moving and 0.3 dB to settle. Worth ~2.5 dB.

**Gain chased silence.** Level lock followed the decaying tail after someone stopped talking, pushing their gain up so the next word arrived far too loud. Symmetric smoothing was replaced with a decaying peak hold, plus a freeze once someone stops.

**The freeze was not enough.** Discord's `audioDetected` stays on through trail-offs and breath, so low-level noise kept refreshing the "still speaking" timer and gain kept climbing anyway. Observed live: two speakers pinned at 178% and 200% when their learned level called for about 58%. Now gain only moves while someone is within 10 dB of their *own* normal speaking level.

**Silence got a vote on the target.** With the gate at −52 dB, room tone entered people's learned levels, and a "−43.8 dB speaker" who was not speaking dragged the shared target down to −37.7 dB, slamming genuine speakers into the volume floor. Gate raised to −40 dB, and a person now needs 20 windows of real speech before they influence the target.

---

## The ceiling

Discord's volume stops at 200%, and that is the main thing standing between this and a perfect result. A speaker 9 dB below the room needs 282%.

`setLocalVolume` accepts higher values, but Discord's audio context settings sync overwrites them on its next run, so they silently snap back. Working around it needs a webpack-level patch of the sync itself, which is what Vencord's VolumeBooster does. This plugin does not attempt it and caps at 200%.

Because of that cap, the target is chosen to be *reachable*: pushed down until the quietest real speaker fits inside the available gain range. It is still one absolute level for everyone, just one everybody can actually be brought to.

---

## Install

1. Install [BetterDiscord](https://betterdiscord.app).
2. Drop `VoiceBalancer.plugin.js` into `%APPDATA%\BetterDiscord\plugins`.
3. Enable it in Discord → Settings → Plugins.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| Auto-balance | on | Off keeps measuring without changing anyone |
| Respect manual changes | on | Move someone's slider yourself and it stops touching them |
| Restore volumes on disable | on | Puts everyone back when you switch it off |
| Minimum volume | 8% | Floor. Low on purpose — a hot mic peaking near 0 dBFS needs to come down to roughly a tenth |
| Maximum volume | 200% | Discord's hard ceiling |
| Noise gate | −40 dB | Below this is room tone, not speech |

---

## Limitations

- **Desktop only.** BetterDiscord does not run in a browser tab.
- **Your own mic is untouched.** This is entirely about what *you* hear.
- **Anyone you set to 0 stays silenced.**
- **Client mods are against Discord's ToS.** Enforcement against plain client mods is effectively nonexistent, but it is a real term and the choice is yours.

If you want a true single gate with sub-millisecond response, that lives outside Discord: route output through [VoiceMeeter](https://vb-audio.com/Voicemeeter/) and use its compressor. It cannot tell who is speaking, so it cannot learn people — but it processes the real audio, which no plugin can.

---

## Testing

```bash
node test/harness.js
```

Eleven checks: control-loop convergence against synthetic speakers, level-scale calibration across four plausible encodings, level-lock equalising three simultaneous speakers, write-rate sanity, and an end-to-end run through the real `rtp.inbound` shape using levels captured from an actual call. Discord is mocked throughout — these verify the logic, not the integration.

---

## License

MIT
