import express from "express";
import puppeteer from "puppeteer";
import { buildHtml } from "./build-html.mjs";

const app = express();
app.use(express.json({ limit: "12mb" }));

// --- Logging por request (verás X-Req-Id que envíes desde GAS) ---
app.use((req, _res, next) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    console.log(`[render] <- ${req.method} ${req.url} rid=${rid}`);
    next();
});

// Seguridad simple por API Key (opcional)
app.use((req, res, next) => {
    const key = process.env.API_KEY;
    if (!key) return next(); // sin key, sin validación (dev)
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

        // 1) Construir HTML base
        const rawHtml = buildHtml({ ast, data, flags, cssTokens, options });

        // 2) Incrustar imágenes externas como data:URI (Drive / HTTP)
        const html = await inlineExternalImages(rawHtml, rid);

        // 3) Lanzar navegador y renderizar
        const browser = await puppeteer.launch({
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"]
        });
        const page = await browser.newPage();

        // El viewport no afecta al PDF, pero ayuda al layout previo
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

        // Cargar contenido
        await page.setContent(html, { waitUntil: "load", timeout: 120000 });

        // Asegurar que todas las imágenes están listas
        await page.evaluate(async () => {
            const imgs = Array.from(document.images || []);
            await Promise.all(imgs.map(img => {
                if (img.complete) return;
                return new Promise(resolve => {
                    img.addEventListener("load", resolve, { once: true });
                    img.addEventListener("error", resolve, { once: true });
                });
            }));
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
            pdf_base64: Buffer.from(pdf).toString("base64")
            // , html_debug: process.env.RETURN_HTML === "1" ? html : undefined
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
    const srcs = Array.from(html.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi)).map(m => m[1]);
    if (!srcs.length) return html;

    const map = new Map();
    await Promise.all(srcs.map(async (src) => {
        try {
            const url = toAbsoluteDriveUrl(src);
            const resp = await fetch(url, { redirect: "follow" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            const ct = resp.headers.get("content-type") || guessContentType(url) || "application/octet-stream";
            const dataUri = `data:${ct};base64,${buf.toString("base64")}`;
            map.set(src, dataUri);
            if (url !== src) map.set(url, dataUri);
        } catch (err) {
            console.warn(`[render][img][skip] src=${src} rid=${rid} err=${err?.message || err}`);
        }
    }));

    let out = html;
    for (const [from, to] of map) {
        const safe = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(safe, "g"), to);
    }
    return out;
}

/** Normaliza Drive ID/URL a un endpoint descargable directo */
function toAbsoluteDriveUrl(src) {
    // ID puro
    if (/^[a-zA-Z0-9_-]{20,}$/.test(src)) {
        return `https://drive.google.com/uc?export=download&id=${src}`;
    }
    // URL /file/d/{id}/view
    const m = /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/.exec(src);
    if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
    return src;
}

function guessContentType(u) {
    const low = (u || "").toLowerCase();
    if (low.includes(".png")) return "image/png";
    if (low.includes(".jpg") || low.includes(".jpeg")) return "image/jpeg";
    if (low.includes(".webp")) return "image/webp";
    if (low.includes(".svg")) return "image/svg+xml";
    return null;
}