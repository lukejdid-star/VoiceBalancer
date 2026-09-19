# VoiceBalancer

A BetterDiscord plugin that automatically balances how loud everyone sounds in a voice channel.

One friend clips your headphones every time they laugh. Another is a whisper you can never quite hear. Discord gives you a per-user volume slider to fix this by hand, one person at a time, forever. VoiceBalancer does it for you: it learns how loud each person actually speaks and sets their volume so everyone lands at the same level.

It remembers people, so the next call starts already balanced.

---

## Status: alpha — works in test, not yet confirmed against a live client

The control loop is implemented and tested. Against synthetic speakers it pulls a 19 dB spread down to **3.5 dB** — the remainder being Discord's 200% volume ceiling, not the algorithm. It converges without oscillating and leaves already-balanced channels alone. `node test/harness.js` reproduces all of it.

The measurement layer reads per-user levels from the media engine's `VoiceActivity` event:

```js
mediaEngine.on("VoiceActivity", (userId, level) => { ... })
```

This event is real — it's in Discord's own client type definitions, and it's emitted by the native engine, which is what makes this viable on the desktop app at all. The end-to-end test drives the plugin through exactly this path with a mocked engine and it balances correctly.

What hasn't happened yet is one run against a real Discord client with real people talking. Two things could still bite: the `level` value's numeric range is undocumented (the plugin calibrates it from observation rather than assuming — see `normalise()`), and the event may only fire under conditions the type definitions don't state.

So **the first live run is the real test.** Join a call with a few people, open the plugin's settings, and look at the Status block. If it shows a source and starts listing people with measured levels, it works. If it shows `source NONE`, or the numbers look wrong, hit **Copy diagnostic report** and open an issue — that report dumps exactly what your client exposes.

The plugin fails safe: if it can't find a level source it says so plainly and does nothing.

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

**Measure.** The media engine reports voice activity per user. Every 250 ms the plugin takes the peak of those reports per person — peaks rather than averages, because the gaps between words drag an average down and don't reflect how loud someone actually sounds. Anything below the noise gate is discarded as room tone.

**Estimate.** Each person gets a running loudness figure in dBFS that converges fast over the first few seconds of speech and then settles into a slow average, so one shout doesn't redefine them. Measurements are saved per user ID and reloaded next session.

**Correct.** Once someone has roughly six seconds of measured speech, they're eligible. The plugin takes the median loudness of everyone it's confident about, works out the volume that would put each person at that median, and walks them toward it a third of the way per pass. Gradual, so you don't hear it happening.

Three details that matter:

- **Hysteresis, not a deadzone.** It takes a 1.5 dB difference to start correcting someone, but once started it goes all the way to within 0.3 dB. A plain deadzone stops every correction about a decibel short of where it belongs — that was a real bug, caught by the harness, worth ~2.5 dB of final spread.
- **Median, not a fixed target.** Balancing toward the middle of the room keeps the overall mix at the level you're already used to, instead of quietly turning everything down.
- **Levels are assumed pre-volume.** Treating a post-volume level as pre-volume is safe: the loop just converges more slowly, through feedback. The reverse runs away — subtracting a gain that was never applied drives volume until it pins against the clamp. So sources declare pre-volume unless genuinely certain.

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

This is a hard limit and the main thing standing between the plugin and a perfect result. A genuinely quiet speaker can need more than 200% to reach everyone else — in testing, someone 9 dB below the room needed 282%.

`setLocalVolume` accepts higher values, but Discord's audio context settings sync overwrites them the next time it runs, so they silently snap back. Working around that needs a webpack-level patch of the sync itself, which is what Vencord's VolumeBooster does. VoiceBalancer doesn't attempt it, and caps at 200%.

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

Nine checks across three areas: control-loop convergence against synthetic speakers (realistic, pathological, and already-balanced channels), level-scale calibration against four plausible encodings of the engine's undocumented value, and an end-to-end run through the real `VoiceActivity` wiring with a mocked engine. Discord is mocked throughout, so this verifies the logic and nothing about the live integration.

---

## License

MIT
