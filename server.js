import express from "express";
import puppeteer from "puppeteer";

const app = express();
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const BASE = "https://aniwatchtv.to";

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

async function siteGet(path) {
    const r = await fetch(`${BASE}${path}`, {
        headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": BASE + "/" },
        signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
}
async function siteJson(path) { return (await siteGet(path)).json(); }
async function siteHtml(path) { return (await siteGet(path)).text(); }

// ─── Puppeteer with stealth ───────────────────────────────────────────────
let _browser = null;
async function getBrowser() {
    if (_browser) {
        try { await _browser.version(); return _browser; } catch { _browser = null; }
    }
    _browser = await puppeteer.launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
        args: [
            "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
            "--disable-gpu", "--no-zygote", "--single-process",
            "--disable-blink-features=AutomationControlled",
            `--user-agent=${UA}`
        ]
    });
    return _browser;
}

async function extractStream(embedUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const intercepted = [];
    const allRequests = [];

    // Spoof navigator.webdriver
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "plugins", { get: () => [1,2,3,4,5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US","en"] });
        window.chrome = { runtime: {} };
    });

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Referer": "https://aniwatchtv.to/" });
    await page.setRequestInterception(true);

    page.on("request", req => {
        const u = req.url();
        allRequests.push(u);
        if ((u.includes(".m3u8") || u.includes(".mp4")) && !intercepted.includes(u)) {
            console.log("[PPTR] intercepted:", u);
            intercepted.push(u);
        }
        const blocked = ["doubleclick","googlesyndication","adservice","amazon-adsystem","facebook","hotjar","clarity"];
        blocked.some(b => u.includes(b)) ? req.abort() : req.continue();
    });

    page.on("response", async r => {
        const u = r.url();
        if ((u.includes(".m3u8") || u.includes(".mp4")) && !intercepted.includes(u)) {
            console.log("[PPTR] response stream:", u);
            intercepted.push(u);
        }
    });

    try {
        console.log("[PPTR] navigating to:", embedUrl);
        await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 35000 });
        await new Promise(r => setTimeout(r, 6000));

        console.log("[PPTR] total requests made:", allRequests.length);
        console.log("[PPTR] intercepted so far:", intercepted);

        // Log all requests containing video-related keywords
        const videoReqs = allRequests.filter(u =>
            u.includes("m3u8") || u.includes(".mp4") || u.includes("stream") ||
            u.includes("video") || u.includes("source") || u.includes("getSources") ||
            u.includes("master") || u.includes("index")
        );
        console.log("[PPTR] video-related requests:", videoReqs);

        if (!intercepted.length) {
            // DOM scan
            const found = await page.evaluate(() => {
                const hits = [];
                document.querySelectorAll("video source,video").forEach(el => { if (el.src) hits.push("VIDEO:"+el.src); });
                document.querySelectorAll("script").forEach(s => {
                    const m = s.textContent.match(/["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/i);
                    if (m) hits.push("SCRIPT:"+m[1]);
                });
                // Also grab page title to confirm page loaded
                hits.push("TITLE:"+document.title);
                return hits;
            });
            console.log("[PPTR] DOM scan:", found);
            const streams = found.filter(f => !f.startsWith("TITLE:")).map(f => f.replace(/^(VIDEO:|SCRIPT:)/,""));
            intercepted.push(...streams);
        }

        return intercepted[0] || null;
    } finally {
        await page.close();
    }
}

// ─── M3U8 proxy ───────────────────────────────────────────────────────────
async function proxyM3u8(m3u8Url, referer, res) {
    const r = await fetch(m3u8Url, {
        headers: { "User-Agent": UA, "Referer": referer || "https://megacloud.blog/" },
        signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error("m3u8 fetch failed: " + r.status);
    let text = await r.text();
    const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
    const enc = u => "/proxy/seg?url=" + encodeURIComponent(u.startsWith("http") ? u : base + u)
                   + "&ref=" + encodeURIComponent(referer || m3u8Url);
    text = text.replace(/^(#EXT-X-KEY:.*URI=")([^"]+)(")/gm, (_, a, u, b) => a + enc(u) + b);
    text = text.replace(/^([^#].+\.ts.*)$/gm,   l => enc(l.trim()));
    text = text.replace(/^([^#].+\.aac.*)$/gm,  l => enc(l.trim()));
    text = text.replace(/^([^#].+\.m3u8.*)$/gm, l => enc(l.trim()));
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
}

app.get("/proxy/seg", async (req, res) => {
    const { url, ref } = req.query;
    if (!url) return res.status(400).send("Missing url");
    try {
        const r = await fetch(url, {
            headers: { "User-Agent": UA, "Referer": ref || "https://megacloud.blog/" },
            signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) return res.status(r.status).send("Upstream error");
        res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/proxy/m3u8", async (req, res) => {
    const { url, ref } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url" });
    try { await proxyM3u8(url, ref, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/",     (_, res) => res.json({ status: "alive", service: "swach-api" }));
app.get("/ping", (_, res) => res.json({ status: "alive" }));

app.get("/api/popular", async (req, res) => {
    try {
        const html = await siteHtml("/home");
        const items = [...html.matchAll(/film-poster-ahref[^>]*title="([^"]+)"[^>]*data-id="(\d+)"/g)];
        res.json({ success: true, data: items.slice(0,20).map(m => ({ id: m[2], slug: m[2], title: m[1], name: m[1] })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/search", async (req, res) => {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ success: false, error: "Missing keyword" });
    try {
        const html = await siteHtml(`/search?keyword=${encodeURIComponent(keyword)}`);
        const items = [...html.matchAll(/film-poster-ahref[^>]*title="([^"]+)"[^>]*data-id="(\d+)"/g)];
        const animes = items.map(m => ({
            id: m[2], slug: m[2], title: m[1], name: m[1],
            image: null, coverImage: { large: null }
        }));
        res.json({ success: true, count: animes.length, data: animes });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/episodes/:slug", async (req, res) => {
    const { slug } = req.params;
    try {
        const d = await siteJson(`/ajax/v2/episode/list/${slug}`);
        if (!d.html) throw new Error("No episode HTML");
        const items = [...d.html.matchAll(/<a[^>]*\bdata-number="(\d+)"[^>]*\bdata-id="(\d+)"[^>]*>/gs)];
        const items2 = items.length ? items : [...d.html.matchAll(/<a[^>]*\bdata-id="(\d+)"[^>]*\bdata-number="(\d+)"[^>]*>/gs)];
        const episodes = (items.length ? items : items2).map((m, _, arr) => {
            const isFirst = arr === items;
            const num = isFirst ? m[1] : m[2];
            const id  = isFirst ? m[2] : m[1];
            const titleMatch = m[0].match(/\btitle="([^"]+)"/);
            return { id, episodeId: id, number: parseInt(num), episode: parseInt(num),
                     title: titleMatch ? titleMatch[1] : `Episode ${num}`, slug: `${slug}-episode-${num}` };
        });
        res.json({ success: true, episodes, data: episodes });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/stream/:epId", async (req, res) => {
    const { epId } = req.params;
    const serverType   = req.query.server_type || "sub";
    const includeProxy = req.query.include_proxy_url === "true";
    try {
        const svData = await siteJson(`/ajax/v2/episode/servers?episodeId=${epId}`);
        if (!svData.html) throw new Error("No server HTML");
        const blocks = [...svData.html.matchAll(/<div[^>]*class="[^"]*server-item[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
        const servers = blocks.map(b => ({
            slotId:   b[0].match(/data-id="(\d+)"/)?.[1],
            serverId: b[0].match(/data-server-id="(\d+)"/)?.[1],
            type:     b[0].match(/data-type="([^"]+)"/)?.[1],
            name:     b[1].replace(/<[^>]+>/g, "").trim()
        })).filter(s => s.slotId && s.type === serverType);

        const server = servers.find(s => s.serverId !== "1") || servers[0];
        if (!server) throw new Error("No servers for type: " + serverType);

        const srcData = await siteJson(`/ajax/v2/episode/sources?id=${server.slotId}`);
        const embedUrl = srcData.link;
        if (!embedUrl) throw new Error("No embed link");
        console.log(`[STREAM] server=${server.name} embed=${embedUrl}`);

        const streamUrl = await extractStream(embedUrl);
        if (!streamUrl) throw new Error("Could not extract stream");
        console.log(`[STREAM] extracted=${streamUrl}`);

        const proxyUrl = `/proxy/m3u8?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent(embedUrl)}`;
        const stream = {
            name: server.name,
            sources: [{ file: streamUrl, type: "hls", ...(includeProxy ? { proxy_url: proxyUrl } : {}) }],
            subtitles: [], skips: {}, headers: { Referer: embedUrl }
        };
        res.json({ success: true, streams: [stream], data: { streams: [stream] } });
    } catch (e) {
        console.error("[STREAM] error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`◈ Swach API running on port ${PORT}`));
