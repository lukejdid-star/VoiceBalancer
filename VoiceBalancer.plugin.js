/**
 * @name VoiceBalancer
 * @author lukej
 * @version 0.1.0
 * @description Automatically balances how loud everyone in a voice channel sounds. Learns each person's speaking level and adjusts their per-user volume so nobody blows out your ears and nobody is a whisper.
 * @source https://github.com/lukejdid-star/VoiceBalancer
 * @updateUrl https://raw.githubusercontent.com/lukejdid-star/VoiceBalancer/main/VoiceBalancer.plugin.js
 */

"use strict";

class VoiceBalancer {

    // ---------------------------------------------------------------------
    // Defaults
    // ---------------------------------------------------------------------

    static get DEFAULTS() {
        return {
            enabled: true,

            // Target loudness. "median" keeps the overall mix at roughly the level
            // you're used to; "fixed" pins everyone to targetDb instead.
            targetMode: "median",
            targetDb: -26,

            // Volume clamp, in Discord's 0-200 percent scale.
            minVolume: 30,
            maxVolume: 200,

            // How much of the correction to apply per adjustment pass. Lower is
            // gentler and less prone to audible pumping.
            slew: 0.34,

            // Don't bother adjusting for differences smaller than this.
            deadzoneDb: 1.5,

            // Speech samples required before we trust a measurement enough to act.
            // Windows are WINDOW_MS long, so 24 windows is about 6 seconds of speech.
            minWindows: 24,

            // Ignore anything quieter than this - room tone, keyboard, breathing.
            noiseGateDb: -52,

            // Seconds between adjustment passes.
            adjustInterval: 4,

            // Stop auto-adjusting someone once you move their slider by hand.
            respectManual: true,

            // Put everyone back how you had them when the plugin is turned off.
            restoreOnStop: true,

            // User IDs to never touch.
            ignored: [],

            // Persisted measurements, keyed by user ID: { db, windows, updated }
            profiles: {},

            debug: false
        };
    }

    // Sampling window. Peak level per window is what feeds the loudness estimate -
    // peaks track perceived loudness far better than instantaneous means, which get
    // dragged down by the pauses between words.
    static get WINDOW_MS() { return 250; }
    static get POLL_MS() { return 50; }

    // Once a correction is underway, how close we get before calling it done.
    static get SETTLE_DB() { return 0.3; }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    constructor(meta) {
        this.meta = meta;
        this.settings = Object.assign({}, VoiceBalancer.DEFAULTS, BdApi.Data.load("VoiceBalancer", "settings") || {});

        // Runtime state, all keyed by user ID.
        this.tracked = new Map();     // id -> { db, windows, applied, original, manual }
        this.window = new Map();      // id -> peak linear level in the current window
        this.source = null;
        this.probeReport = null;
        this._applying = false;
        this._timers = [];
    }

    start() {
        this.log("starting");

        if (!this.resolveModules()) {
            BdApi.UI.showToast("VoiceBalancer: couldn't find Discord's voice internals. Discord may have changed - check the console.", { type: "error" });
            return;
        }

        this.hydrateProfiles();
        this.patchVolumeSetter();

        this.probeReport = this.probe();
        if (this.settings.debug) console.log("[VoiceBalancer] probe:\n" + this.probeReport);

        this.source = this.selectLevelSource();

        if (!this.source) {
            BdApi.UI.showToast("VoiceBalancer: no audio level source available on this client. Open settings and copy the diagnostic report.", { type: "warning", timeout: 8000 });
            this.log("no level source; running inert");
            return;
        }

        this.log(`level source: ${this.source.name} (postVolume=${this.source.isPostVolume})`);
        this.source.start((userId, linear) => this.onSample(userId, linear));

        this._timers.push(setInterval(() => this.closeWindow(), VoiceBalancer.WINDOW_MS));
        this._timers.push(setInterval(() => this.adjustPass(), this.settings.adjustInterval * 1000));
    }

    stop() {
        this.log("stopping");

        for (const t of this._timers) clearInterval(t);
        this._timers = [];

        if (this.source) {
            try { this.source.stop(); } catch (e) { this.log("source stop failed", e); }
            this.source = null;
        }

        BdApi.Patcher.unpatchAll("VoiceBalancer");

        if (this.settings.restoreOnStop) this.restoreAll();

        this.persistProfiles();
        this.saveSettings();
    }

    // ---------------------------------------------------------------------
    // Discord module resolution
    // ---------------------------------------------------------------------

    resolveModules() {
        const { Webpack } = BdApi;

        const store = (name) => {
            try {
                if (Webpack.getStore) return Webpack.getStore(name);
            } catch (e) { /* older BD */ }
            try {
                return Webpack.getModule(Webpack.Filters.byStoreName(name));
            } catch (e) {
                return null;
            }
        };

        this.MediaEngineStore = store("MediaEngineStore");
        this.SpeakingStore = store("SpeakingStore");
        this.VoiceStateStore = store("VoiceStateStore");
        this.SelectedChannelStore = store("SelectedChannelStore");
        this.UserStore = store("UserStore");

        // The module that owns setLocalVolume. Name has moved around over the years,
        // so match on the function itself rather than a module name.
        this.VolumeActions = BdApi.Webpack.getModule(m => m && typeof m.setLocalVolume === "function");

        const missing = [];
        if (!this.MediaEngineStore) missing.push("MediaEngineStore");
        if (!this.VolumeActions) missing.push("setLocalVolume");
        if (!this.SelectedChannelStore) missing.push("SelectedChannelStore");

        if (missing.length) {
            console.error("[VoiceBalancer] missing modules:", missing.join(", "));
            return false;
        }
        return true;
    }

    // ---------------------------------------------------------------------
    // Volume read / write
    // ---------------------------------------------------------------------

    getVolume(userId) {
        try {
            const v = this.MediaEngineStore.getLocalVolume(userId);
            return typeof v === "number" && isFinite(v) ? v : 100;
        } catch (e) {
            return 100;
        }
    }

    setVolume(userId, volume) {
        // Hard ceiling at Discord's own limit. Values above 200 are accepted by
        // setLocalVolume but the audio context settings sync reverts them, so
        // going higher would just produce volumes that silently snap back.
        const v = Math.round(Math.max(0, Math.min(200, volume)) * 100) / 100;
        this._applying = true;
        try {
            // Arity has varied: some builds take a media context as a third argument.
            try {
                this.VolumeActions.setLocalVolume(userId, v);
            } catch (e) {
                this.VolumeActions.setLocalVolume(userId, v, "default");
            }
        } catch (e) {
            this.log("setLocalVolume failed", e);
        } finally {
            this._applying = false;
        }
    }

    // Notice when the user drags a slider themselves and back off that person.
    patchVolumeSetter() {
        if (!this.settings.respectManual) return;

        BdApi.Patcher.before("VoiceBalancer", this.VolumeActions, "setLocalVolume", (_, args) => {
            if (this._applying) return;
            const userId = args[0];
            if (!userId) return;
            const t = this.tracked.get(userId);
            if (t) {
                t.manual = true;
                this.log(`manual override on ${userId}, backing off`);
            } else {
                this.tracked.set(userId, this.blank({ manual: true }));
            }
        });
    }

    // ---------------------------------------------------------------------
    // Level source discovery
    //
    // This is the part that varies between Discord builds. Rather than guess, we
    // try each known strategy in order of reliability and use the first that
    // actually produces samples.
    // ---------------------------------------------------------------------

    selectLevelSource() {
        const candidates = [
            () => new VoiceActivityLevelSource(this),
            () => new StatsLevelSource(this),
            () => new AudioElementLevelSource(this)
        ];

        for (const make of candidates) {
            try {
                const s = make();
                if (s.available()) return s;
            } catch (e) {
                this.log("source candidate failed", e);
            }
        }
        return null;
    }

    getEngine() {
        try { return this.MediaEngineStore.getMediaEngine(); } catch (e) { return null; }
    }

    getConnections() {
        const engine = this.getEngine();
        if (!engine) return [];
        const raw = engine.connections;
        if (!raw) return [];
        try { return Array.from(raw); } catch (e) { return []; }
    }

    // Everyone in your current voice channel except you.
    peers() {
        const out = [];
        try {
            const channelId = this.SelectedChannelStore.getVoiceChannelId();
            if (!channelId) return out;
            const me = this.UserStore?.getCurrentUser?.()?.id;
            const states = this.VoiceStateStore?.getVoiceStatesForChannel?.(channelId) || {};
            for (const id of Object.keys(states)) {
                if (id !== me) out.push(id);
            }
        } catch (e) { /* not in voice */ }
        return out;
    }

    speakingNow() {
        const out = [];
        if (!this.SpeakingStore?.isSpeaking) return out;
        for (const id of this.peers()) {
            try { if (this.SpeakingStore.isSpeaking(id)) out.push(id); } catch (e) { /* ignore */ }
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Measurement
    // ---------------------------------------------------------------------

    blank(extra) {
        return Object.assign({ db: null, windows: 0, applied: null, original: null, manual: false, correcting: false }, extra || {});
    }

    onSample(userId, linear) {
        // A source that can't attribute a sample passes null; in that case we
        // attribute it to whoever is speaking, but only when exactly one person
        // is - otherwise we'd be measuring a mix of two voices.
        if (!userId) {
            const talking = this.speakingNow();
            if (talking.length !== 1) return;
            userId = talking[0];
        }

        if (this.settings.ignored.includes(userId)) return;
        if (!isFinite(linear) || linear <= 0) return;

        const prev = this.window.get(userId) || 0;
        if (linear > prev) this.window.set(userId, linear);
    }

    // Fold each window's peak into that user's running loudness estimate.
    closeWindow() {
        if (this.window.size === 0) return;

        for (const [userId, peak] of this.window) {
            const db = toDb(peak);
            if (db < this.settings.noiseGateDb) continue;

            let t = this.tracked.get(userId);
            if (!t) { t = this.blank(); this.tracked.set(userId, t); }

            // If levels arrive after local volume is applied, back that out so the
            // estimate describes the raw stream and isn't chasing our own changes.
            //
            // Treating a post-volume level as pre-volume is safe - the loop just
            // converges more slowly, via feedback. The reverse is not: subtracting
            // a gain that was never applied drives volume away from target until it
            // pins against the clamp. So every source here declares pre-volume
            // unless it is genuinely certain otherwise.
            let raw = db;
            if (this.source?.isPostVolume) {
                const vol = this.getVolume(userId);
                raw = db - toDb(Math.max(vol, 1) / 100);
            }

            // Converge fast on the first few windows, then settle into a slow average.
            const alpha = Math.max(0.03, 1 / (t.windows + 1));
            t.db = t.db === null ? raw : t.db + alpha * (raw - t.db);
            t.windows++;
        }

        this.window.clear();
    }

    confident() {
        const out = [];
        for (const [id, t] of this.tracked) {
            if (t.db !== null && t.windows >= this.settings.minWindows && !t.manual) out.push([id, t]);
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Correction
    // ---------------------------------------------------------------------

    adjustPass() {
        if (!this.settings.enabled) return;

        const ready = this.confident();
        if (ready.length === 0) return;

        const target = this.settings.targetMode === "fixed"
            ? this.settings.targetDb
            : median(ready.map(([, t]) => t.db));

        if (!isFinite(target)) return;

        const inChannel = new Set(this.peers());

        for (const [userId, t] of ready) {
            if (!inChannel.has(userId)) continue;

            const current = this.getVolume(userId);

            // A deliberately silenced user stays silenced.
            if (current <= 0) continue;

            if (t.original === null) t.original = current;

            // Where the volume needs to land for this person to hit the target.
            const wanted = clamp(
                100 * fromDb(target - t.db),
                this.settings.minVolume,
                this.settings.maxVolume
            );

            const errDb = toDb(Math.max(wanted, 1)) - toDb(Math.max(current, 1));

            // Hysteresis. It takes a real difference to start correcting someone,
            // but once started we go the whole way - otherwise the deadzone halts
            // every correction a decibel or so short of where it belongs.
            const band = t.correcting ? VoiceBalancer.SETTLE_DB : this.settings.deadzoneDb;
            if (Math.abs(errDb) < band) { t.correcting = false; continue; }
            t.correcting = true;

            // Walk part of the way there so changes are gradual rather than abrupt.
            const next = current + (wanted - current) * this.settings.slew;
            const final = clamp(next, this.settings.minVolume, this.settings.maxVolume);

            // Arrived, or pinned against a clamp - either way stop nudging.
            if (Math.abs(final - current) < 0.5) { t.correcting = false; continue; }

            this.setVolume(userId, final);
            t.applied = final;

            this.log(`${this.nameOf(userId)}: ${t.db.toFixed(1)}dB -> vol ${current.toFixed(0)} => ${final.toFixed(0)} (target ${target.toFixed(1)}dB)`);
        }

        this.persistProfiles();
    }

    restoreAll() {
        for (const [userId, t] of this.tracked) {
            if (t.original !== null && t.applied !== null) {
                this._applying = true;
                try { this.setVolume(userId, t.original); } catch (e) { /* ignore */ }
                this._applying = false;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------

    hydrateProfiles() {
        const profiles = this.settings.profiles || {};
        const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 60; // forget after 60 days
        for (const [id, p] of Object.entries(profiles)) {
            if (!p || typeof p.db !== "number" || (p.updated || 0) < cutoff) continue;
            this.tracked.set(id, this.blank({ db: p.db, windows: p.windows || 0 }));
        }
        this.log(`restored ${this.tracked.size} profiles`);
    }

    persistProfiles() {
        const profiles = {};
        for (const [id, t] of this.tracked) {
            if (t.db === null || t.manual) continue;
            profiles[id] = { db: t.db, windows: Math.min(t.windows, 400), updated: Date.now() };
        }
        this.settings.profiles = profiles;
        this.saveSettings();
    }

    saveSettings() {
        BdApi.Data.save("VoiceBalancer", "settings", this.settings);
    }

    // ---------------------------------------------------------------------
    // Diagnostics
    //
    // Dumps what this particular Discord build exposes. If the plugin can't find
    // a level source, this report is what makes it fixable.
    // ---------------------------------------------------------------------

    probe() {
        const lines = [];
        const push = (s) => lines.push(s);

        push("VoiceBalancer diagnostic");
        push("plugin " + (this.meta?.version || "?"));
        push("ua " + navigator.userAgent);
        push("");

        push("modules:");
        push("  MediaEngineStore      " + !!this.MediaEngineStore);
        push("  SpeakingStore         " + !!this.SpeakingStore);
        push("  VoiceStateStore       " + !!this.VoiceStateStore);
        push("  SelectedChannelStore  " + !!this.SelectedChannelStore);
        push("  setLocalVolume        " + !!this.VolumeActions);
        push("");

        const engine = this.getEngine();
        push("media engine: " + (engine ? "found" : "MISSING"));

        if (engine) {
            push("  emitter (on/off): " + (typeof engine.on === "function" && typeof engine.off === "function"));
            push("  methods: " + methodsOf(engine).join(", "));
            const conns = this.getConnections();
            push("  connections: " + conns.length);

            conns.forEach((c, i) => {
                push(`  [conn ${i}] methods: ` + methodsOf(c).join(", "));
                push(`  [conn ${i}] keys: ` + Object.keys(c).slice(0, 60).join(", "));

                // The two things that decide whether this works at all.
                push(`  [conn ${i}] getStats: ` + (typeof c.getStats === "function"));
                push(`  [conn ${i}] ssrc-ish keys: ` + Object.keys(c).filter(k => /ssrc|user|peer/i.test(k)).join(", "));

                if (typeof c.getStats === "function") {
                    try {
                        const r = c.getStats();
                        if (r && typeof r.then === "function") {
                            r.then(s => console.log(`[VoiceBalancer] conn ${i} getStats() ->`, s))
                             .catch(e => console.log(`[VoiceBalancer] conn ${i} getStats() rejected`, e));
                            push(`  [conn ${i}] getStats() is async - result logged to console`);
                        } else {
                            push(`  [conn ${i}] getStats() sync -> ` + safeShape(r));
                        }
                    } catch (e) {
                        push(`  [conn ${i}] getStats() threw: ` + e.message);
                    }
                }
            });
        }

        push("");
        const media = document.querySelectorAll("audio, video");
        push(`media elements in DOM: ${media.length}`);
        let withStream = 0;
        media.forEach(el => { if (el.srcObject) withStream++; });
        push(`  with srcObject (tappable via Web Audio): ${withStream}`);

        push("");
        push("voice channel: " + (this.SelectedChannelStore.getVoiceChannelId() || "not connected"));
        push("peers: " + this.peers().length);
        push("");
        push("selected source: " + (this.source ? this.source.name : "NONE"));

        return lines.join("\n");
    }

    // ---------------------------------------------------------------------
    // Settings UI
    // ---------------------------------------------------------------------

    getSettingsPanel() {
        const root = document.createElement("div");
        root.style.cssText = "color:var(--text-normal);font-size:14px;padding:4px 2px;";

        const section = (title) => {
            const h = document.createElement("h3");
            h.textContent = title;
            h.style.cssText = "color:var(--header-primary);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;margin:20px 0 10px;";
            root.appendChild(h);
        };

        const note = (text) => {
            const p = document.createElement("div");
            p.textContent = text;
            p.style.cssText = "color:var(--text-muted);font-size:12px;line-height:1.45;margin:-4px 0 12px;";
            root.appendChild(p);
        };

        const toggle = (key, label, desc) => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;align-items:flex-start;gap:10px;margin:10px 0;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!this.settings[key];
            cb.style.cssText = "margin-top:2px;cursor:pointer;";
            cb.onchange = () => { this.settings[key] = cb.checked; this.saveSettings(); };
            const txt = document.createElement("div");
            txt.innerHTML = `<div>${label}</div><div style="color:var(--text-muted);font-size:12px;margin-top:2px;">${desc || ""}</div>`;
            wrap.append(cb, txt);
            root.appendChild(wrap);
        };

        const slider = (key, label, min, max, step, fmt) => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "margin:14px 0;";
            const head = document.createElement("div");
            head.style.cssText = "display:flex;justify-content:space-between;margin-bottom:6px;";
            const val = document.createElement("span");
            val.style.cssText = "color:var(--text-muted);font-variant-numeric:tabular-nums;";
            val.textContent = fmt(this.settings[key]);
            head.innerHTML = `<span>${label}</span>`;
            head.appendChild(val);
            const input = document.createElement("input");
            input.type = "range";
            input.min = min; input.max = max; input.step = step;
            input.value = this.settings[key];
            input.style.cssText = "width:100%;cursor:pointer;";
            input.oninput = () => {
                this.settings[key] = parseFloat(input.value);
                val.textContent = fmt(this.settings[key]);
            };
            input.onchange = () => this.saveSettings();
            wrap.append(head, input);
            root.appendChild(wrap);
        };

        const button = (label, fn, primary) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.style.cssText = `padding:8px 14px;margin:4px 8px 4px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500;background:${primary ? "var(--button-danger-background,#da373c)" : "var(--background-modifier-selected,#4e5058)"};color:#fff;`;
            b.onclick = fn;
            root.appendChild(b);
            return b;
        };

        // --- status ---
        section("Status");
        const status = document.createElement("div");
        status.style.cssText = "font-family:var(--font-code,monospace);font-size:12px;line-height:1.7;background:var(--background-secondary);border-radius:6px;padding:12px;white-space:pre-wrap;max-height:260px;overflow:auto;";
        root.appendChild(status);

        const renderStatus = () => {
            const rows = [];
            rows.push(`source   ${this.source ? this.source.name : "NONE — auto-balancing inactive"}`);
            rows.push(`tracking ${this.tracked.size} people`);
            rows.push("");
            const ready = this.confident();
            if (ready.length) {
                const target = this.settings.targetMode === "fixed"
                    ? this.settings.targetDb
                    : median(ready.map(([, t]) => t.db));
                rows.push(`target   ${target.toFixed(1)} dB`);
                rows.push("");
            }
            if (this.tracked.size === 0) {
                rows.push("No measurements yet. Join a voice call and let people talk.");
            }
            for (const [id, t] of this.tracked) {
                const name = this.nameOf(id);
                const lvl = t.db === null ? "  --  " : `${t.db.toFixed(1)}dB`;
                const conf = Math.min(100, Math.round((t.windows / this.settings.minWindows) * 100));
                const flag = t.manual ? " [manual]" : (conf >= 100 ? "" : ` ${conf}%`);
                rows.push(`${name.padEnd(22).slice(0, 22)} ${lvl}  vol ${String(Math.round(this.getVolume(id))).padStart(3)}${flag}`);
            }
            status.textContent = rows.join("\n");
        };
        renderStatus();
        // Stop refreshing once the panel is closed - but only after we've seen it
        // mounted, since BD attaches it a moment after getSettingsPanel returns.
        let everAttached = false;
        const statusTimer = setInterval(() => {
            const attached = document.body.contains(status);
            if (attached) everAttached = true;
            else if (everAttached) return clearInterval(statusTimer);
            renderStatus();
        }, 1000);

        // --- behaviour ---
        section("Behaviour");
        toggle("enabled", "Auto-balance", "Turn off to keep measuring without changing anyone's volume.");
        toggle("respectManual", "Respect manual changes", "Once you move someone's slider yourself, stop adjusting them.");
        toggle("restoreOnStop", "Restore volumes on disable", "Put everyone back how you had them when this plugin is switched off.");

        section("Tuning");
        slider("slew", "Adjustment strength", 0.05, 1, 0.01, v => `${Math.round(v * 100)}%`);
        note("How much of the correction to apply each pass. Lower is gentler and less likely to pump.");
        slider("minVolume", "Minimum volume", 0, 100, 5, v => `${v}%`);
        slider("maxVolume", "Maximum volume", 100, 200, 5, v => `${v}%`);
        note("200% is Discord's ceiling. Higher values are accepted locally but get reverted the next time settings sync, so this doesn't go past it.");
        slider("minWindows", "Speech needed before acting", 8, 120, 4, v => `${(v * VoiceBalancer.WINDOW_MS / 1000).toFixed(1)}s`);
        slider("noiseGateDb", "Noise gate", -70, -30, 1, v => `${v} dB`);
        note("Anything quieter than this is treated as room tone, not speech.");

        // --- data ---
        section("Data");
        button("Reset all measurements", () => {
            this.tracked.clear();
            this.window.clear();
            this.settings.profiles = {};
            this.saveSettings();
            renderStatus();
            BdApi.UI.showToast("VoiceBalancer: measurements cleared", { type: "success" });
        });

        button("Copy diagnostic report", async () => {
            const report = this.probe();
            try {
                await navigator.clipboard.writeText(report);
                BdApi.UI.showToast("Diagnostic copied to clipboard", { type: "success" });
            } catch (e) {
                console.log(report);
                BdApi.UI.showToast("Couldn't copy — report printed to console instead", { type: "warning" });
            }
        });

        if (!this.source) {
            const warn = document.createElement("div");
            warn.style.cssText = "margin-top:16px;padding:12px;border-radius:6px;background:var(--background-secondary);border-left:3px solid var(--status-danger,#da373c);font-size:12px;line-height:1.5;";
            warn.textContent = "No audio level source was found on this Discord build, so auto-balancing can't run. Join a voice call, then use \"Copy diagnostic report\" and open an issue with the output — that report says exactly what this client exposes.";
            root.appendChild(warn);
        }

        return root;
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    nameOf(userId) {
        try {
            const u = this.UserStore?.getUser?.(userId);
            return u?.globalName || u?.username || userId;
        } catch (e) {
            return userId;
        }
    }

    log(...args) {
        if (this.settings?.debug) console.log("[VoiceBalancer]", ...args);
    }
}

// -------------------------------------------------------------------------
// Level sources
// -------------------------------------------------------------------------

/**
 * The media engine's own per-user voice activity meter:
 *
 *     mediaEngine.on("VoiceActivity", (userId, level) => ...)
 *
 * This is the path that matters. On the Discord desktop client voice is handled
 * by the native engine and never reaches the renderer, so there is no element to
 * tap and no RTCPeerConnection to inspect - but the engine reports activity per
 * user regardless. Same event on web.
 *
 * The level's scale is undocumented, so it is calibrated from observation rather
 * than assumed. See normalise().
 */
class VoiceActivityLevelSource {
    constructor(plugin) {
        this.plugin = plugin;
        this.name = "media-engine-voice-activity";
        this.isPostVolume = false;
        this._engine = null;
        this._handler = null;
        this._reattach = null;
        this._peak = 0;
        this._seen = 0;
    }

    available() {
        const engine = this.plugin.getEngine();
        return !!(engine && typeof engine.on === "function" && typeof engine.off === "function");
    }

    start(onSample) {
        this.onSample = onSample;
        this._handler = (userId, level) => {
            const linear = this.normalise(level);
            if (linear !== null) this.onSample(String(userId), linear);
        };
        this.attach();

        // The engine is rebuilt on device changes and some reconnects, which
        // silently drops our listener. Cheap to re-check.
        this._reattach = setInterval(() => this.attach(), 5000);
    }

    attach() {
        const engine = this.plugin.getEngine();
        if (!engine || engine === this._engine) return;
        this.detach();
        try {
            engine.on("VoiceActivity", this._handler);
            this._engine = engine;
            this.plugin.log("attached VoiceActivity listener");
        } catch (e) {
            this.plugin.log("VoiceActivity attach failed", e);
        }
    }

    detach() {
        if (!this._engine) return;
        try { this._engine.off("VoiceActivity", this._handler); } catch (e) { /* ignore */ }
        this._engine = null;
    }

    stop() {
        if (this._reattach) clearInterval(this._reattach);
        this._reattach = null;
        this.detach();
    }

    /**
     * Map whatever the engine reports onto linear 0..1.
     *
     * Discord documents no range for this value. Rather than guess one, watch the
     * magnitudes actually coming through and pick the interpretation that fits:
     * negatives are already dBFS, small positives are unit scale, and larger ones
     * are either percent or raw 16-bit sample values.
     */
    normalise(v) {
        if (typeof v !== "number" || !isFinite(v)) return null;
        if (v < 0) return fromDb(v);
        if (v === 0) return null;

        if (v > this._peak) this._peak = v;
        this._seen++;

        // Provisional guess until there's enough evidence to commit.
        if (this._seen < 20) return v > 1 ? v / 100 : v;

        if (this._peak <= 1.5) return v;
        if (this._peak <= 150) return v / 100;
        return v / 32768;
    }
}

/**
 * Pulls audioLevel out of the voice connection's WebRTC stats. Fallback for
 * clients where the engine doesn't emit VoiceActivity.
 */
class StatsLevelSource {
    constructor(plugin) {
        this.plugin = plugin;
        this.name = "webrtc-stats";
        this.isPostVolume = false;
        this._timer = null;
        this._ssrcToUser = new Map();
    }

    available() {
        const conns = this.plugin.getConnections();
        return conns.some(c => typeof c.getStats === "function");
    }

    start(onSample) {
        this.onSample = onSample;
        this._timer = setInterval(() => this.tick(), 100);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async tick() {
        // getStats() is async; skip a tick rather than letting slow calls pile up.
        if (this._busy) return;
        this._busy = true;
        try { await this.collect(); } finally { this._busy = false; }
    }

    async collect() {
        for (const conn of this.plugin.getConnections()) {
            if (typeof conn.getStats !== "function") continue;

            this.learnSsrcMap(conn);

            let stats;
            try { stats = await conn.getStats(); } catch (e) { continue; }
            if (!stats) continue;

            // Standard RTCStatsReport.
            if (typeof stats.forEach === "function" && !Array.isArray(stats)) {
                stats.forEach(r => {
                    if (r && r.type === "inbound-rtp" && typeof r.audioLevel === "number") {
                        this.emit(r.ssrc, r.audioLevel);
                    }
                });
                continue;
            }

            // Discord's own shape: { inbound: [...] }.
            const inbound = stats.inbound || stats.inboundRtp || stats.receivers;
            if (Array.isArray(inbound)) {
                for (const r of inbound) {
                    const lvl = r.audioLevel ?? r.audio_level ?? r.level;
                    if (typeof lvl === "number") this.emit(r.ssrc ?? r.userId ?? null, lvl);
                }
            }
        }
    }

    // Connections generally carry some ssrc -> user mapping; the key name has
    // moved around, so accept any of the plausible ones.
    learnSsrcMap(conn) {
        const candidate = conn.ssrcMap || conn.ssrcs || conn._ssrcMap || conn.userSsrcs;
        if (!candidate) return;
        try {
            const entries = candidate instanceof Map ? candidate.entries() : Object.entries(candidate);
            for (const [k, v] of entries) {
                // Mapping may run either direction depending on build.
                if (typeof v === "string" && /^\d{15,}$/.test(v)) this._ssrcToUser.set(String(k), v);
                else if (v && typeof v === "object" && v.audioSsrc) this._ssrcToUser.set(String(v.audioSsrc), String(k));
                else if (typeof v === "number") this._ssrcToUser.set(String(v), String(k));
            }
        } catch (e) { /* mapping unavailable */ }
    }

    emit(ssrc, level) {
        // A raw snowflake means the stats were already user-keyed.
        if (typeof ssrc === "string" && /^\d{15,}$/.test(ssrc)) return this.onSample(ssrc, level);
        const userId = ssrc == null ? null : this._ssrcToUser.get(String(ssrc)) || null;
        // Unmapped samples fall through to speaking-based attribution.
        this.onSample(userId, level);
    }
}

/**
 * Taps any <audio>/<video> element carrying a live MediaStream with the Web Audio
 * API. Works on the browser client and on forks that route voice through the
 * renderer; on Discord desktop there is nothing here to tap.
 *
 * Pre-volume, despite appearances: createMediaStreamSource reads the MediaStream,
 * and the element's .volume applies to playback downstream of that.
 */
class AudioElementLevelSource {
    constructor(plugin) {
        this.plugin = plugin;
        this.name = "web-audio-tap";
        this.isPostVolume = false;
        this._ctx = null;
        this._taps = new Map();
        this._timer = null;
        this._scan = null;
    }

    available() {
        return this.elements().length > 0;
    }

    elements() {
        return Array.from(document.querySelectorAll("audio, video")).filter(el => el.srcObject);
    }

    start(onSample) {
        this.onSample = onSample;
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.rescan();
        this._scan = setInterval(() => this.rescan(), 3000);
        this._timer = setInterval(() => this.tick(), VoiceBalancer.POLL_MS);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        if (this._scan) clearInterval(this._scan);
        for (const tap of this._taps.values()) {
            try { tap.node.disconnect(); } catch (e) { /* ignore */ }
        }
        this._taps.clear();
        try { this._ctx?.close(); } catch (e) { /* ignore */ }
        this._ctx = null;
    }

    rescan() {
        for (const el of this.elements()) {
            if (this._taps.has(el)) continue;
            try {
                const src = this._ctx.createMediaStreamSource(el.srcObject);
                const analyser = this._ctx.createAnalyser();
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = 0.2;
                src.connect(analyser);
                // Deliberately not connected to the destination - this is a tap,
                // not a second playback path.
                this._taps.set(el, { node: src, analyser, buf: new Float32Array(analyser.fftSize) });
            } catch (e) { /* element not tappable */ }
        }

        for (const [el, tap] of this._taps) {
            if (!document.body.contains(el) || !el.srcObject) {
                try { tap.node.disconnect(); } catch (e) { /* ignore */ }
                this._taps.delete(el);
            }
        }
    }

    tick() {
        for (const tap of this._taps.values()) {
            tap.analyser.getFloatTimeDomainData(tap.buf);
            let peak = 0;
            for (let i = 0; i < tap.buf.length; i++) {
                const a = Math.abs(tap.buf[i]);
                if (a > peak) peak = a;
            }
            if (peak > 0) this.onSample(null, peak); // attributed by who's speaking
        }
    }
}

// -------------------------------------------------------------------------
// Math / reflection utilities
// -------------------------------------------------------------------------

function toDb(linear) {
    return 20 * Math.log10(Math.max(linear, 1e-6));
}

function fromDb(db) {
    return Math.pow(10, db / 20);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function methodsOf(obj) {
    const out = new Set();
    let cur = obj;
    let depth = 0;
    while (cur && cur !== Object.prototype && depth < 4) {
        for (const k of Object.getOwnPropertyNames(cur)) {
            try { if (typeof obj[k] === "function") out.add(k); } catch (e) { /* getter threw */ }
        }
        cur = Object.getPrototypeOf(cur);
        depth++;
    }
    return Array.from(out).sort();
}

function safeShape(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return String(v);
    if (depth > 2) return "...";
    const t = typeof v;
    if (t !== "object") return t === "string" ? `"${v.slice(0, 40)}"` : String(v);
    if (Array.isArray(v)) return `[${v.length}] ` + (v.length ? safeShape(v[0], depth + 1) : "");
    return "{" + Object.keys(v).slice(0, 20).join(", ") + "}";
}

// Exposed for test/harness.js.
VoiceBalancer.sources = { VoiceActivityLevelSource, StatsLevelSource, AudioElementLevelSource };

module.exports = VoiceBalancer;
