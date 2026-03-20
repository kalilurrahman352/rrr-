#!/usr/bin/env node
const crypto = require("crypto");
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const CONFIG = {
    prefix: "a1b7c",
    apiEndpoint: "http://52.44.108.84:8084/new/record",
    pidFile: path.join(__dirname, ".aibtc.pid"),
    logFile: path.join(__dirname, ".aibtc.log"),
    statsFile: path.join(__dirname, ".aibtc.stats"),
    BATCH_SIZE: 800,
    SLEEP_MS: 0,
};
const C = { reset:"\x1b[0m",green:"\x1b[32m",yellow:"\x1b[33m",blue:"\x1b[34m",magenta:"\x1b[35m",cyan:"\x1b[36m",red:"\x1b[31m" };

function calcSleep(cpu) {
    const work = CONFIG.BATCH_SIZE * 0.35;
    return cpu >= 100 ? 0 : Math.max(0, Math.round(work * (100 - cpu) / cpu));
}
function log(msg, c) {
    c = c || "reset";
    const ts = new Date().toISOString();
    console.log(C[c] + msg + C.reset);
    try { fs.appendFileSync(CONFIG.logFile, "[" + ts + "] " + msg + "\n"); } catch(_) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function save(s) { try { fs.writeFileSync(CONFIG.statsFile, JSON.stringify(s,null,2)); } catch(_) {} }
function load() {
    try { return JSON.parse(fs.readFileSync(CONFIG.statsFile,"utf8")); } catch(_) {}
    return { totalHashes:0, found:0, accepted:0, rejected:0, startTime:null, wallets:[] };
}
function savePid(p) { fs.writeFileSync(CONFIG.pidFile, String(p)); }
function delPid() { try { fs.unlinkSync(CONFIG.pidFile); } catch(_) {} }
function getPid() { try { return parseInt(fs.readFileSync(CONFIG.pidFile,"utf8"),10)||null; } catch(_) { return null; } }
function alive(pid) { try { process.kill(pid,0); return true; } catch(_) { return false; } }

let _bufCache = {};
function genAddr(wallet, seed1, seed2) {
    if (!_bufCache[wallet]) {
        const ab = Buffer.from(wallet.toLowerCase(),"utf8");
        _bufCache[wallet] = { ab, s1:Buffer.alloc(8), s2:Buffer.alloc(8), cb:Buffer.allocUnsafe(ab.length+16) };
        ab.copy(_bufCache[wallet].cb, 0);
    }
    const b = _bufCache[wallet];
    b.s1.writeBigInt64BE(BigInt(seed1));
    b.s2.writeBigInt64BE(BigInt(seed2));
    b.s1.copy(b.cb, b.ab.length);
    b.s2.copy(b.cb, b.ab.length + 8);
    const hash = crypto.createHash("sha256").update(b.cb).digest();
    let pk = BigInt("0x" + hash.toString("hex")) % N;
    if (pk === 0n) pk = 1n;
    const sk = new ethers.SigningKey("0x" + pk.toString(16).padStart(64,"0"));
    return ethers.computeAddress(sk.publicKey).toLowerCase();
}

async function submit(wallet, seed1, seed2) {
    try {
        const res = await axios.post(CONFIG.apiEndpoint,
            { address: wallet, seed1, seed2 },
            { timeout: 10000, headers: { "Content-Type": "application/json" } }
        );
        const data = res.data;
        const raw = JSON.stringify(data);
        const isAccepted = data && (
            data.code === 0 || data.success === true ||
            data.status === "ok" || data.status === "success" ||
            raw === '"ok"' || raw === '"success"' ||
            (data.data && data.data.message && data.data.message.toLowerCase().includes("success"))
        );
        const isRejected = data && (
            data.success === false || data.error !== undefined ||
            data.status === "error" || data.code === 1 ||
            raw.toLowerCase().includes("invalid") ||
            raw.toLowerCase().includes("reject") ||
            raw.toLowerCase().includes("duplicate")
        );
        return { ok: isAccepted && !isRejected, raw, status: res.status };
    } catch(e) {
        const serverMsg = e.response ? JSON.stringify(e.response.data) : e.message;
        return { ok: false, raw: serverMsg, status: e.response ? e.response.status : 0 };
    }
}

// Submit same proof to ALL wallets in parallel
async function submitToAll(wallets, seed1, seed2) {
    log(`📤 Submitting to ${wallets.length} wallets in parallel...`, "blue");
    const results = await Promise.all(
        wallets.map(w => submit(w, seed1, seed2).then(r => ({ wallet: w, ...r })))
    );
    let acc = 0, rej = 0;
    for (const r of results) {
        const short = r.wallet.slice(0, 8) + "..." + r.wallet.slice(-4);
        if (r.ok) {
            acc++;
            log(`  ✅ ${short} → ACCEPTED`, "green");
        } else {
            rej++;
            log(`  ❌ ${short} → ${r.raw}`, "red");
        }
    }
    log(`📊 Batch result: ${acc} accepted / ${rej} rejected`, acc > 0 ? "green" : "red");
    return { accepted: acc, rejected: rej };
}

async function mine(wallets, cpu) {
    // Validate all wallets
    for (const w of wallets) {
        if (!ethers.isAddress(w)) {
            log(`❌ Invalid wallet: ${w}`, "red");
            process.exit(1);
        }
    }
    const ex = getPid();
    if (ex && alive(ex)) { log("⚠️  Already running PID " + ex, "yellow"); process.exit(1); }
    savePid(process.pid);
    CONFIG.SLEEP_MS = calcSleep(cpu);
    const stats = load();
    stats.startTime = Date.now();
    stats.wallets = wallets;
    save(stats);

    // Use first wallet as "mining" address for hash generation
    const miningWallet = wallets[0];

    console.log("\n" + C.cyan +
        "╔══════════════════════════════════════════════════════════╗\n" +
        "║      ⛏️  AIBTC MULTI-WALLET MINER v4.0 ⛏️               ║\n" +
        "╚══════════════════════════════════════════════════════════╝"
    + C.reset + "\n");
    log(`🔷 Wallets  : ${wallets.length} wallets loaded`, "blue");
    wallets.forEach((w, i) => log(`   [${i+1}] ${w}`, "cyan"));
    log(`🔷 CPU      : ~${cpu}% (sleep ${CONFIG.SLEEP_MS}ms per batch)`, "blue");
    log(`🔷 Prefix   : address[0..10] contains [${CONFIG.prefix}]`, "blue");
    log(`🔷 Strategy : Each found hash → submitted to ALL ${wallets.length} wallets`, "magenta");
    console.log("");
    log("✅ Mining started... Ctrl+C to stop", "green");
    console.log("");

    let hashes=0, found=0, accepted=0, rejected=0;
    let batch=0, lastDisplay=Date.now();

    const shutdown = sig => {
        console.log("");
        log(sig + " – stopping...", "yellow");
        const s = load();
        s.totalHashes = (s.totalHashes||0) + hashes;
        s.found = (s.found||0) + found;
        s.accepted = (s.accepted||0) + accepted;
        s.rejected = (s.rejected||0) + rejected;
        save(s);
        delPid();
        const secs = Math.max(1,(Date.now()-stats.startTime)/1000);
        log("✅ Stopped","green");
        console.log("\n" + C.cyan + "📊 Session:" + C.reset);
        console.log("   Hashes   : " + hashes.toLocaleString());
        console.log("   H/s      : " + Math.floor(hashes/secs).toLocaleString());
        console.log("   Found    : " + found);
        console.log("   Accepted : " + C.green + accepted + C.reset + " (across all wallets)");
        console.log("   Rejected : " + C.red + rejected + C.reset + "\n");
        process.exit(0);
    };
    process.on("SIGINT",  () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    while (true) {
        const seed1 = Date.now() + Math.floor(Math.random() * 1_000_000);
        for (let seed2 = 0; seed2 <= 2_000_000; seed2++) {
            const addr   = genAddr(miningWallet, seed1, seed2);
            const addr40 = addr.slice(2);
            hashes++;
            batch++;
            if (batch >= CONFIG.BATCH_SIZE) {
                batch = 0;
                if (CONFIG.SLEEP_MS > 0) await sleep(CONFIG.SLEEP_MS);
            }
            if (Date.now() - lastDisplay > 15000) {
                const secs = (Date.now()-stats.startTime)/1000;
                process.stdout.write(
                    "\r" + C.cyan +
                    "⛏️  " + hashes.toLocaleString() +
                    " | " + Math.floor(hashes/secs).toLocaleString() + " H/s" +
                    " | Wallets: " + wallets.length +
                    " | Found: " + found +
                    " | " + C.green + "✓" + accepted + C.cyan +
                    " | " + C.red + "✗" + rejected + C.cyan +
                    C.reset + "   "
                );
                lastDisplay = Date.now();
            }
            const check10 = addr40.slice(0, 10);
            if (!check10.includes(CONFIG.prefix)) continue;

            found++;
            console.log("");
            log("🎯 MATCH FOUND! Submitting to all " + wallets.length + " wallets...", "green");
            log("   Address : " + addr, "yellow");
            log("   Seed1   : " + seed1, "yellow");
            log("   Seed2   : " + seed2, "yellow");

            // KEY: submit to ALL wallets!
            const res = await submitToAll(wallets, seed1, seed2);
            accepted += res.accepted;
            rejected += res.rejected;

            const s = load();
            s.totalHashes = (s.totalHashes||0) + hashes;
            s.found = (s.found||0) + found;
            s.accepted = (s.accepted||0) + accepted;
            s.rejected = (s.rejected||0) + rejected;
            save(s);
        }
    }
}

function stop() {
    const pid = getPid();
    if (!pid || !alive(pid)) { log("⚠️  Not running","yellow"); delPid(); return; }
    log("🛑 Stopping PID " + pid, "yellow");
    try {
        process.kill(pid,"SIGTERM");
        setTimeout(()=>{ if(alive(pid)) process.kill(pid,"SIGKILL"); delPid(); log("✅ Stopped","green"); }, 2000);
    } catch(e) { log("❌ "+e.message,"red"); delPid(); }
}

function status() {
    const pid = getPid(), s = load();
    console.log("\n" + C.cyan + "📊 AIBTC STATUS\n" + C.reset);
    if (pid && alive(pid)) { log("✅ RUNNING","green"); log("   PID: "+pid,"blue"); }
    else { log("⏹️  STOPPED","yellow"); delPid(); }
    console.log("   Wallets  : " + (s.wallets ? s.wallets.length : 0));
    console.log("   Hashes   : " + (s.totalHashes||0).toLocaleString());
    console.log("   Found    : " + (s.found||0));
    console.log("   Accepted : " + C.green + (s.accepted||0) + C.reset);
    console.log("   Rejected : " + C.red + (s.rejected||0) + C.reset + "\n");
}

const cmd     = process.argv[2];
const walletsArg = process.argv[3] || "";
const cpuArg  = parseInt(process.argv[4], 10);
const cpu     = (!isNaN(cpuArg) && cpuArg >= 1 && cpuArg <= 100) ? cpuArg : 100;

// Support comma-separated wallets: "0xAAA,0xBBB,0xCCC"
const wallets = walletsArg.split(",").map(w => w.trim()).filter(w => w.length > 0);

switch (cmd) {
    case "run":
        if (!wallets.length) {
            console.log("Usage: node aibtc.js run <WALLET1,WALLET2,...> [cpu%]");
            console.log("Example: node aibtc.js run 0xAAA,0xBBB,0xCCC 100");
            process.exit(1);
        }
        mine(wallets, cpu);
        break;
    case "stop":   stop();   break;
    case "status": status(); break;
    default:
        console.log("node aibtc.js run <WALLET1,WALLET2,...> [cpu%]");
        process.exit(0);
}
