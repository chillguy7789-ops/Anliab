import express from "express";
import puppeteer from "puppeteer";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/ping", (req, res) => res.json({ status: "alive" }));

app.get("/extract", async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

    console.log(`◈ Extracting: ${url}`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--single-process"
            ]
        });

        const page = await browser.newPage();
        const intercepted = [];

        await page.setRequestInterception(true);
        page.on("request", req => {
            const u = req.url();
            if (u.includes(".m3u8") || u.includes(".mp4")) {
                console.log("◈ INTERCEPTED:", u);
                intercepted.push(u);
            }
            const blocked = ["doubleclick", "googlesyndication", "adservice", "amazon-adsystem", "facebook"];
            if (blocked.some(b => u.includes(b))) {
                req.abort();
            } else {
                req.continue();
            }
        });

        page.on("response", async r => {
            const u = r.url();
            if ((u.includes(".m3u8") || u.includes(".mp4")) && !intercepted.includes(u)) {
                console.log("◈ RESPONSE STREAM:", u);
                intercepted.push(u);
            }
        });

        // Set referer if provided
        if (referer) {
            await page.setExtraHTTPHeaders({ Referer: referer });
        }

        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // DOM scan fallback
        if (!intercepted.length) {
            const found = await page.evaluate(() => {
                const hits = [];
                document.querySelectorAll("video source, video").forEach(el => {
                    if (el.src) hits.push(el.src);
                });
                document.querySelectorAll("script").forEach(s => {
                    const m = s.textContent.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
                    if (m) hits.push(m[1]);
                });
                return hits;
            });
            if (found.length) intercepted.push(...found);
        }

        if (!intercepted.length) {
            return res.status(404).json({ error: "No stream URL found" });
        }

        console.log("◈ SUCCESS:", intercepted[0]);
        res.json({ stream: intercepted[0], all: intercepted });

    } catch (e) {
        console.error("◈ ERROR:", e.message);
        res.status(500).json({ error: e.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => console.log(`◈ Server running on port ${PORT}`));
