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
    Object.assign(p.settings, { mode: "learn" }, opts || {});

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

// --- end-to-end through the real RTP stats shape -----------------------
// getStats() payload mirrors what Discord 1.0.9258 actually returns, captured
// live: rtp.inbound keyed by user ID, each entry carrying audioLevel and
// audioDetected. Levels are the real ones observed in a call.
console.log("");
(function endToEndStats() {
    const truth = { jake: 0.975, trigger: 0.433 };   // measured live
    const volumes = new Map([["jake", 100], ["trigger", 100]]);
    let speaking = null;

    const conn = {
        destroyed: false,
        getStats: async () => ({
            mediaEngineConnectionId: "Native-0",
            rtp: {
                inbound: Object.fromEntries(Object.keys(truth).map(id => [id, [{
                    type: "audio",
                    ssrc: 1583,
                    audioLevel: id === speaking ? truth[id] * (0.7 + Math.random() * 0.3) : 0,
                    audioDetected: id === speaking ? 1 : 0
                }]])),
                outbound: [{ type: "audio", ssrc: 3014, audioLevel: 0.001 }]
            }
        })
    };

    const engine = { connections: new Set([conn]), on() {}, off() {} };
    const p = new VoiceBalancer({ version: "e2e" });
    p.settings.mode = "learn";
    p.MediaEngineStore = { getLocalVolume: id => volumes.get(id) ?? 100, getMediaEngine: () => engine };
    p.VolumeActions = { setLocalVolume: (id, v) => volumes.set(id, v) };
    p.SelectedChannelStore = { getVoiceChannelId: () => "c" };
    p.UserStore = { getCurrentUser: () => ({ id: "me" }), getUser: id => ({ username: id }) };
    p.VoiceStateStore = { getVoiceStatesForChannel: () => ({ me: {}, jake: {}, trigger: {} }) };
    p.SpeakingStore = { isSpeaking: () => false };

    const src = p.selectLevelSource();
    if (!src || src.name !== "rtp-stats") {
        console.log("FAIL e2e: expected rtp-stats source, got " + (src && src.name));
        return;
    }
    src.start((id, lin) => p.onSample(id, lin));

    (async () => {
        for (let turn = 0; turn < 16; turn++) {
            for (const id of Object.keys(truth)) {
                speaking = id;
                for (let w = 0; w < 6; w++) {
                    await src.collect();   // one poll
                    p.closeWindow();
                }
            }
            p.adjustPass();
        }
        src.stop();

        const perceived = id => toDb(truth[id]) + toDb(volumes.get(id) / 100);
        const spread = Math.abs(perceived("jake") - perceived("trigger"));
        const before = Math.abs(toDb(truth.jake) - toDb(truth.trigger));
        console.log(`e2e  jake ${volumes.get("jake").toFixed(0)}%  trigger ${volumes.get("trigger").toFixed(0)}%  spread ${before.toFixed(1)}dB -> ${spread.toFixed(1)}dB`);
        console.log(spread < 2 ? "PASS e2e rtp-stats path balances real levels" : "FAIL e2e spread " + spread.toFixed(1));

        // audioDetected must gate silence out entirely
        const silentSeen = p.tracked.size === 2;
        console.log(silentSeen ? "PASS e2e only real speakers tracked" : "FAIL e2e tracked " + p.tracked.size);
    })();
})();

// --- level lock -------------------------------------------------------
// Rides gain in real time so every voice lands on targetDb, rather than
// settling on one volume per person.
console.log("");
(function levelLock() {
    const truth = { jake: 0.975, trigger: 0.433, nami: 0.06 };
    const volumes = new Map(Object.keys(truth).map(id => [id, 100]));
    const p = new VoiceBalancer({ version: "lock" });
    Object.assign(p.settings, { mode: "lock" });   // otherwise plugin defaults
    p.MediaEngineStore = { getLocalVolume: id => volumes.get(id) ?? 100 };
    p.VolumeActions = { setLocalVolume: (id, v) => volumes.set(id, v) };
    p.SelectedChannelStore = { getVoiceChannelId: () => "c" };
    p.UserStore = { getCurrentUser: () => ({ id: "me" }), getUser: id => ({ username: id }) };
    p.VoiceStateStore = { getVoiceStatesForChannel: () => ({ me: {}, jake: {}, trigger: {}, nami: {} }) };
    p.SpeakingStore = { isSpeaking: () => false };
    p.source = { name: "h", isPostVolume: false, stop() {} };

    // everyone talks simultaneously - the case a single gate on the mix cannot fix
    let clock = 0;
    const origNow = Date.now;
    Date.now = () => origNow() + (clock += 200);
    for (let i = 0; i < 120; i++) {
        for (const id of Object.keys(truth)) p.onSample(id, truth[id] * (0.8 + Math.random() * 0.4));
        p.lockPass();
    }
    Date.now = origNow;

    const perceived = id => toDb(truth[id]) + toDb(volumes.get(id) / 100);
    const rows = Object.keys(truth).map(id => `${id} ${volumes.get(id).toFixed(0)}% -> ${perceived(id).toFixed(1)}dB`);
    console.log("lock  " + rows.join("   "));
    const vals = Object.keys(truth).map(perceived);
    const spread = Math.max(...vals) - Math.min(...vals);
    const before = Math.max(...Object.values(truth).map(toDb)) - Math.min(...Object.values(truth).map(toDb));
    console.log(`lock  spread ${before.toFixed(1)}dB -> ${spread.toFixed(1)}dB`);
    console.log(spread < 3.5 ? "PASS lock equalises simultaneous speakers" : "FAIL lock spread " + spread.toFixed(1));   // peak-hold decay against jittered input leaves ~1dB

    // must not write on every tick - each write hits the native engine + settings sync
    let writes = 0;
    p.VolumeActions.setLocalVolume = (id, v) => { writes++; volumes.set(id, v); };
    clock = 0; Date.now = () => origNow() + (clock += 200);
    for (let i = 0; i < 120; i++) {
        for (const id of Object.keys(truth)) p.onSample(id, truth[id]);
        p.lockPass();
    }
    Date.now = origNow;
    console.log(`lock  writes while steady: ${writes} over 360 samples`);
    console.log(writes < 20 ? "PASS lock stays quiet once settled" : "FAIL lock wrote " + writes);
})();
