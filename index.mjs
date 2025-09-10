// index.mjs
import express from "express";
import puppeteer from "puppeteer";
import { buildHtml } from "./build-html.mjs";

const app = express();
app.use(express.json({ limit: "12mb" }));

// Logging por request
app.use((req, _res, next) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    console.log(`[render] <- ${req.method} ${req.url} rid=${rid}`);
    next();
});

// Seguridad simple por API Key (opcional)
app.use((req, res, next) => {
    const key = process.env.API_KEY;
    if (!key) return next();
    if (req.headers["x-api-key"] !== key) {
        console.warn(`[render] 401 unauthorized rid=${req.headers["x-req-id"] || "no-req-id"}`);
        return res.status(401).json({ error: "unauthorized" });
    }
    next();
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/render", async (req, res) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    const t0 = Date.now();
    try {
        const { ast, data, flags = [], cssTokens = {}, options = {} } = req.body || {};
        if (!ast || !Array.isArray(ast.blocks) || !ast.byBlock) {
            console.warn(`[render] 400 invalid_ast rid=${rid}`);
            return res.status(400).json({ error: "invalid_ast" });
        }

        // 1) HTML base
        const rawHtml = buildHtml({ ast, data, flags, cssTokens, options });

        // 2) Incrustar imágenes externas como data:URI
        const html = await inlineExternalImages(rawHtml, rid);

        // 3) Render PDF
        const browser = await puppeteer.launch({
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: "load", timeout: 120000 });

        // Espera a imágenes restantes
        await page.evaluate(async () => {
            const imgs = Array.from(document.images || []);
            await Promise.all(
                imgs.map(img => {
                    if (img.complete) return;
                    return new Promise(resolve => {
                        img.addEventListener("load", resolve, { once: true });
                        img.addEventListener("error", resolve, { once: true });
                    });
                })
            );
        });

        const pdf = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            timeout: 120000
        });

        await browser.close();

        console.log(`[render] -> 200 pdf_bytes=${pdf.length} durMs=${Date.now() - t0} rid=${rid}`);
        res.json({
            pdf_base64: Buffer.from(pdf).toString("base64"),
            ...(process.env.RETURN_HTML === "1" ? { html_debug: html } : {})
        });
    } catch (e) {
        console.error(`[render][ERROR] rid=${rid} ${e?.stack || String(e)}`);
        res.status(500).json({ error: "render_failed" });
    }
});

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("renderer listening on", PORT));

/* ==================== Helpers ==================== */

/** Convierte cada <img src="..."> en data:URI para evitar timing/redirects/cookies */
async function inlineExternalImages(html, rid) {
    const IMG_RE = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
    const matches = Array.from(html.matchAll(IMG_RE));
    if (!matches.length) return html;

    const replacements = await Promise.all(
        matches.map(async (m) => {
            const fullTag = m[0];
            const srcAttr = m[1];

            // Si ya viene en data:, no tocar
            if (/^data:/i.test(srcAttr)) return null;

            try {
                const dataUrl = await toDataUrl(srcAttr);
                if (!dataUrl) {
                    console.warn(`[render][img][skip] src=${srcAttr} rid=${rid} err=no_data_url`);
                    return null;
                }
                const newTag = fullTag.replace(srcAttr, dataUrl);
                return { from: fullTag, to: newTag };
            } catch (err) {
                console.warn(`[render][img][skip] src=${srcAttr} rid=${rid} err=${err?.message || err}`);
                return null;
            }
        })
    );

    let out = html;
    for (const r of replacements) {
        if (!r) continue;
        out = out.split(r.from).join(r.to);
    }
    return out;
}

/** Genera una data:URL desde ID/URL de Drive o URL http/https normal */
async function toDataUrl(srcIn) {
    // Normaliza entidades HTML (&amp; -> &)
    let src = htmlUnescape(srcIn);

    // Acepta data: tal cual
    if (/^data:/i.test(src)) return src;

    const id = extractDriveId(src);
    const candidates = [];

    if (id) {
        // Prioriza endpoint descargable estable
        candidates.push(`https://drive.usercontent.google.com/uc?export=download&id=${id}`);
        // Alternos
        candidates.push(`https://lh3.googleusercontent.com/d/${id}=s0`);
        candidates.push(`https://drive.google.com/uc?export=download&id=${id}`);
    } else if (/^https?:\/\//i.test(src)) {
        candidates.push(src);
    } else if (/^[a-zA-Z0-9_-]{20,}$/.test(src)) {
        candidates.push(`https://drive.usercontent.google.com/uc?export=download&id=${src}`);
        candidates.push(`https://lh3.googleusercontent.com/d/${src}=s0`);
        candidates.push(`https://drive.google.com/uc?export=download&id=${src}`);
    } else {
        return "";
    }

    for (const url of candidates) {
        const data = await fetchAsDataUrl(url);
        if (data) return data;
    }
    return "";
}

function extractDriveId(url) {
    if (!/^https?:\/\//i.test(url)) return "";
    return (
        (/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i.exec(url)?.[1]) ||
        (/drive\.google\.com\/uc\?(?:[^#]*&)?id=([a-zA-Z0-9_-]{20,})/i.exec(url)?.[1]) ||
        (/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/i.exec(url)?.[1]) ||
        ""
    );
}

async function fetchAsDataUrl(url) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);

        const res = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome PDF-Renderer",
                "Accept": "image/*,*/*"
            }
        });
        clearTimeout(t);

        if (!res.ok) {
            console.warn(`[render][img][http] ${url} status=${res.status} type=${res.headers.get("content-type") || ""}`);
            return "";
        }

        const ctype = (res.headers.get("content-type") || "").split(";")[0] || guessContentType(url) || "application/octet-stream";
        const ab = await res.arrayBuffer();
        const b64 = Buffer.from(ab).toString("base64");
        return `data:${ctype};base64,${b64}`;
    } catch {
        return "";
    }
}

function guessContentType(u) {
    const low = (u || "").toLowerCase();
    if (low.includes(".png")) return "image/png";
    if (low.includes(".jpg") || low.includes(".jpeg")) return "image/jpeg";
    if (low.includes(".webp")) return "image/webp";
    if (low.includes(".svg")) return "image/svg+xml";
    return null;
}

function htmlUnescape(s) {
    return String(s)
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
}