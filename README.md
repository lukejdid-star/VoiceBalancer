# VoiceBalancer

A BetterDiscord plugin that automatically balances how loud everyone sounds in a voice channel.

One friend clips your headphones every time they laugh. Another is a whisper you can never quite hear. Discord gives you a per-user volume slider to fix this by hand, one person at a time, forever. VoiceBalancer does it for you: it learns how loud each person actually speaks and sets their volume so everyone lands at the same level.

It remembers people, so the next call starts already balanced.

---

## Status: alpha — measurement layer needs field verification

**Read this before installing.**

The control loop is done and tested. Against synthetic speakers it pulls a 19 dB spread down to **0.5 dB**, converges without oscillating, and leaves already-balanced channels alone. You can reproduce that with `node test/harness.js`.

What is **not** verified is the part that reads per-user audio levels out of Discord's media engine. Discord has no public API for this, the internals differ between client builds, and it cannot be tested without a live voice call. The plugin therefore probes your client at startup, tries each known strategy in order, and uses the first one that actually produces samples.

If it can't find one, it says so plainly in its settings panel and does nothing. It will not silently half-work.

**So the first run matters:** join a real voice call with a few people, open the plugin's settings, and look at the Status block. If it shows a source and starts listing people with measured levels, you're good. If it shows `source NONE`, hit **Copy diagnostic report** and open an issue with the output — that report says exactly what your client exposes, and it's what makes this fixable.

---

## Install

1. Install [BetterDiscord](https://betterdiscord.app) if you don't have it.
2. Download `VoiceBalancer.plugin.js`.
3. Drop it in your plugins folder — Discord → Settings → Plugins → **Open Plugins Folder**.
4. Enable **VoiceBalancer** in that list.

Windows path, if you'd rather do it directly:
`%APPDATA%\BetterDiscord\plugins`

---

## How it works

**Measure.** Every 250 ms the plugin takes the peak audio level for each person who spoke during that window. Peaks rather than averages, because the gaps between words drag an average down and don't reflect how loud someone actually sounds. Anything below the noise gate is discarded as room tone.

**Estimate.** Each person gets a running loudness figure in dBFS that converges fast over the first few seconds of speech and then settles into a slow average, so one shout doesn't redefine them. Measurements are saved per user ID and reloaded next session.

**Correct.** Once someone has roughly six seconds of measured speech, they're eligible. The plugin takes the median loudness of everyone it's confident about, works out the volume that would put each person at that median, and walks them toward it a third of the way per pass. Gradual, so you don't hear it happening.

Two details that matter:

- **Hysteresis.** It takes a 1.5 dB difference to start correcting someone, but once started it goes all the way to within 0.3 dB. A plain deadzone stops every correction a decibel short of where it belongs — that was a real bug caught by the test harness, and the fix is worth ~2.5 dB.
- **Median, not a fixed target.** Balancing toward the middle of the room keeps the overall mix at the level you're already used to, instead of quietly turning everything down.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| Auto-balance | on | Off keeps measuring without changing anyone. Useful for watching what it *would* do. |
| Respect manual changes | on | The moment you move someone's slider yourself, it stops touching them. |
| Restore volumes on disable | on | Puts everyone back how you had them when you switch the plugin off. |
| Adjustment strength | 34% | How much of the correction to apply per pass. Lower is gentler. |
| Minimum volume | 30% | Floor. Stops a loud person being driven to inaudible. |
| Maximum volume | 200% | Ceiling. See below. |
| Speech needed before acting | 6 s | How much of someone's voice it wants before trusting the measurement. |
| Noise gate | −52 dB | Below this is treated as room tone, not speech. |

### The 200% ceiling

Discord's own slider stops at 200%, and a genuinely quiet speaker can need more than that to reach everyone else. In testing, a person 9 dB below the room needed 282%.

`setLocalVolume` stores higher values perfectly well, so **Maximum volume** goes to 400%. Raising it is the difference between a 3.5 dB residual spread and a 0.5 dB one. It's off by default because it's beyond what Discord's UI will show you.

---

## Limitations

- **Desktop only.** BetterDiscord doesn't run in a browser tab.
- **It measures people, not moments.** Someone who leans into their mic for one sentence won't be corrected for that sentence — the plugin tracks how loud a person is, not how loud a syllable is. For per-moment control you want a compressor (VoiceMeeter) instead, or as well.
- **Your own mic is not touched.** This is entirely about what *you* hear. If people say *you're* too loud, that's Discord's input sensitivity, not this.
- **Deliberately silenced people stay silenced.** Anyone you've set to 0 is left alone.
- **Client mods are against Discord's ToS.** Enforcement against plain client mods is effectively nonexistent — Discord targets API abuse and selfbots — but it's a real term and the choice is yours.

---

## Testing

```bash
node test/harness.js
```

Drives the control loop with synthetic speakers: a realistic friend group, a pathological case that hits the volume ceiling, and an already-balanced channel that should stay put. The harness mocks Discord entirely, so it verifies the maths and nothing about the integration.

---

## License

MIT
