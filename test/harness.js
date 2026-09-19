// Exercises VoiceBalancer's control loop against synthetic speakers.
// Discord integration can't be tested here; the convergence behaviour can.

const path = require("path");

// --- minimal environment -------------------------------------------------
const store = {};
global.BdApi = {
    Data: { load: () => null, save: (_, __, v) => { store.settings = v; } },
    Patcher: { before: () => {}, unpatchAll: () => {} },
    UI: { showToast: () => {} },
    Webpack: { getStore: () => null, getModule: () => null, Filters: { byStoreName: () => null } }
};
global.document = { querySelectorAll: () => [], body: { contains: () => false } };
global.navigator = { userAgent: "harness" };

const VoiceBalancer = require(path.join(__dirname, "..", "VoiceBalancer.plugin.js"));

const toDb = l => 20 * Math.log10(Math.max(l, 1e-6));
const fromDb = d => Math.pow(10, d / 20);

function run(label, speakers, opts) {
    const p = new VoiceBalancer({ version: "test" });
    Object.assign(p.settings, opts || {});

    const volumes = new Map();
    const ids = Object.keys(speakers);
    ids.forEach(id => volumes.set(id, 100));

    // Fake Discord surface.
    p.MediaEngineStore = { getLocalVolume: id => volumes.get(id) ?? 100 };
    p.VolumeActions = { setLocalVolume: (id, v) => volumes.set(id, v) };
    p.SelectedChannelStore = { getVoiceChannelId: () => "chan" };
    p.UserStore = { getCurrentUser: () => ({ id: "me" }), getUser: id => ({ username: id }) };
    p.VoiceStateStore = {
        getVoiceStatesForChannel: () => {
            const o = { me: {} };
            ids.forEach(id => o[id] = {});
            return o;
        }
    };
    p.SpeakingStore = { isSpeaking: () => false };
    p.source = { name: "harness", isPostVolume: false, stop() {} };

    // Speech: each person takes turns, 40 windows each, with natural variation.
    let passes = 0;
    for (let turn = 0; turn < 14; turn++) {
        for (const id of ids) {
            for (let w = 0; w < 6; w++) {
                // +/- 3dB of sentence-to-sentence variation around their true level
                const jitter = (Math.sin(turn * 2.1 + w * 0.7) * 3);
                p.onSample(id, fromDb(speakers[id] + jitter));
                p.closeWindow();
            }
        }
        p.adjustPass();
        passes++;
    }

    const rows = ids.map(id => {
        const vol = volumes.get(id);
        const perceived = speakers[id] + toDb(vol / 100);
        return { id, trueDb: speakers[id], vol, perceived, est: p.tracked.get(id)?.db };
    });

    const spreadBefore = Math.max(...ids.map(i => speakers[i])) - Math.min(...ids.map(i => speakers[i]));
    const spreadAfter = Math.max(...rows.map(r => r.perceived)) - Math.min(...rows.map(r => r.perceived));

    console.log(`\n=== ${label} ===`);
    console.log("name        true    est     vol    perceived");
    for (const r of rows) {
        console.log(
            `${r.id.padEnd(10)} ${r.trueDb.toFixed(1).padStart(6)}  ${(r.est ?? NaN).toFixed(1).padStart(6)}  ` +
            `${r.vol.toFixed(0).padStart(4)}%  ${r.perceived.toFixed(1).padStart(7)}`
        );
    }
    console.log(`spread: ${spreadBefore.toFixed(1)}dB -> ${spreadAfter.toFixed(1)}dB  (${passes} passes)`);
    return { spreadBefore, spreadAfter };
}

// Typical friend group: one loud, one normal, one soft-spoken.
const a = run("realistic spread", { loudmouth: -14, normal: -24, quiet: -33 });

// Pathological: someone with a broken mic gain, beyond what 200% can rescue.
const b = run("extreme spread (hits Discord's 200% ceiling)", { screamer: -6, normal: -24, whisper: -48 });

// Stability: everyone already matched should produce almost no movement.
const c = run("already balanced (should barely move)", { a: -24, b: -25, c: -23.5 });

console.log("\n--- verdict ---");
console.log(a.spreadAfter < 4 ? "PASS realistic spread collapsed" : "FAIL realistic spread still " + a.spreadAfter.toFixed(1));
console.log(b.spreadAfter < b.spreadBefore ? "PASS extreme improved (ceiling-limited)" : "FAIL extreme got worse");
console.log(c.spreadAfter <= c.spreadBefore + 0.5 ? "PASS balanced case stayed stable" : "FAIL balanced case drifted");


// --- level scale calibration -------------------------------------------
// The engine's VoiceActivity value has no documented range, so the source
// infers it. Check each plausible encoding lands in linear 0..1.
const { VoiceActivityLevelSource } = VoiceBalancer.sources;

function calibrate(label, values, expectPeakNear) {
    const src = new VoiceActivityLevelSource({ log: () => {}, getEngine: () => null });
    let out = [];
    // feed twice: once to build evidence, once to read committed scale
    for (let pass = 0; pass < 2; pass++) out = values.map(v => src.normalise(v));
    const peak = Math.max(...out.filter(v => v !== null));
    const ok = Math.abs(peak - expectPeakNear) < 0.15;
    console.log(`${ok ? "PASS" : "FAIL"} scale ${label.padEnd(22)} peak -> ${peak.toFixed(3)} (want ~${expectPeakNear})`);
    return ok;
}

console.log("");
const unit    = Array.from({length: 30}, (_, i) => (i + 1) / 30);          // 0..1
const percent = Array.from({length: 30}, (_, i) => ((i + 1) / 30) * 100);  // 0..100
const pcm16   = Array.from({length: 30}, (_, i) => ((i + 1) / 30) * 32768); // 0..32768
const dbfs    = Array.from({length: 30}, (_, i) => -60 + i * 2);            // negative dBFS

calibrate("unit 0..1", unit, 1.0);
calibrate("percent 0..100", percent, 1.0);
calibrate("pcm16 0..32768", pcm16, 1.0);
calibrate("dbfs negative", dbfs, Math.pow(10, -2 / 20));

// --- end-to-end through the real VoiceActivity wiring -------------------
// Mocks the media engine as an emitter and drives the plugin the way Discord
// would: engine emits (userId, level), plugin measures, plugin sets volumes.
console.log("");
(function endToEnd() {
    const listeners = {};
    const engine = {
        on: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
        off: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
        connections: new Set()
    };
    const emit = (ev, ...a) => (listeners[ev] || []).forEach(f => f(...a));

    const volumes = new Map([["loud", 100], ["soft", 100]]);
    const truth = { loud: -14, soft: -32 };

    const p = new VoiceBalancer({ version: "e2e" });
    p.MediaEngineStore = { getLocalVolume: id => volumes.get(id) ?? 100, getMediaEngine: () => engine };
    p.VolumeActions = { setLocalVolume: (id, v) => volumes.set(id, v) };
    p.SelectedChannelStore = { getVoiceChannelId: () => "c" };
    p.UserStore = { getCurrentUser: () => ({ id: "me" }), getUser: id => ({ username: id }) };
    p.VoiceStateStore = { getVoiceStatesForChannel: () => ({ me: {}, loud: {}, soft: {} }) };
    p.SpeakingStore = { isSpeaking: () => false };

    const src = p.selectLevelSource();
    if (!src || src.name !== "media-engine-voice-activity") {
        console.log("FAIL e2e: expected VoiceActivity source, got " + (src && src.name));
        return;
    }
    src.start((id, lin) => p.onSample(id, lin));

    // Engine reports on a 0..100 scale here; the source must work that out.
    for (let turn = 0; turn < 14; turn++) {
        for (const id of ["loud", "soft"]) {
            for (let w = 0; w < 6; w++) {
                emit("VoiceActivity", id, fromDb(truth[id]) * 100);
                p.closeWindow();
            }
        }
        p.adjustPass();
    }
    src.stop();

    const perceived = id => truth[id] + toDb(volumes.get(id) / 100);
    const spread = Math.abs(perceived("loud") - perceived("soft"));
    console.log(`e2e  loud ${volumes.get("loud").toFixed(0)}%  soft ${volumes.get("soft").toFixed(0)}%  spread ${spread.toFixed(1)}dB (was 18.0)`);
    console.log(spread < 4 ? "PASS e2e VoiceActivity path balances" : "FAIL e2e spread " + spread.toFixed(1));
    console.log(listeners.VoiceActivity.length === 0 ? "PASS e2e listener detached on stop" : "FAIL e2e listener leaked");
})();
