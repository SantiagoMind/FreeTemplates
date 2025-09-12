// index.mjs — Render HTML->PDF (pdf_base64) + artifacts (asset:<id>) compatible con tu GAS
import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Busboy from "busboy";
import { fileURLToPath } from "url";
import { buildHtml } from "./build-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ========= Config =========
const PORT = process.env.PORT || 10000;
const JSON_LIMIT = process.env.JSON_LIMIT || "64mb";
const API_KEY = process.env.API_KEY || "";
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, "assets"); // almacenamiento local
const ASSETS_PUBLIC_BASE = (process.env.ASSETS_PUBLIC_BASE || "").replace(/\/+$/, ""); // ej: https://cdn.tu-dominio

// ========= Middlewares =========
app.use(express.json({ limit: JSON_LIMIT }));

// Logging por request
app.use((req, _res, next) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    console.log(`[render] <- ${req.method} ${req.url} rid=${rid}`);
    next();
});

// Seguridad simple por API Key (opcional)
app.use((req, res, next) => {
    if (!API_KEY) return next();
    if (req.headers["x-api-key"] !== API_KEY) {
        console.warn(`[render] 401 unauthorized rid=${req.headers["x-req-id"] || "no-req-id"}`);
        return res.status(401).json({ error: "unauthorized" });
    }
    next();
});

// Saludos / health
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("ok"));
app.head("/", (_req, res) => res.status(200).end());

// ========= Static assets =========
fs.mkdirSync(ASSETS_DIR, { recursive: true });
app.use(
    "/assets",
    (_req, res, next) => {
        res.set("Cache-Control", "public,max-age=31536000,immutable");
        next();
    },
    express.static(ASSETS_DIR)
);

// ========= /assets (artifact upload) =========
// Subes un archivo (multipart campo "file") y devuelve { asset_id, size, content_type }
app.post("/assets", (req, res) => {
    const bb = Busboy({ headers: req.headers });
    let responded = false;

    bb.on("file", (_name, stream, info) => {
        const { filename = "file.bin", mimeType = "application/octet-stream" } = info || {};
        const hasher = crypto.createHash("sha256");
        const chunks = [];

        stream.on("data", (d) => {
            hasher.update(d);
            chunks.push(d);
        });

        stream.on("end", () => {
            if (responded) return;
            const buf = Buffer.concat(chunks);
            const sha = hasher.digest("hex");
            const ext = pickExt(filename, mimeType);
            const id = `${sha}.${ext}`;
            const fp = path.join(ASSETS_DIR, id);
            if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
            responded = true;
            res.json({
                asset_id: id,
                size: buf.length,
                content_type: mimeType,
            });
        });
    });

    bb.on("error", (e) => {
        if (!responded) res.status(400).json({ error: "multipart_error", detail: String(e) });
    });

    req.pipe(bb);
});

function pickExt(filename, mime) {
    const extFromName = (filename.toLowerCase().match(/\.(\w{1,10})$/) || [])[1];
    if (extFromName) return extFromName;
    const map = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "application/pdf": "pdf",
    };
    return map[mime] || "bin";
}

// ========= Puppeteer singleton =========
let browser;
async function getBrowser() {
    if (browser) return browser;
    browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--font-render-hinting=none",
        ],
    });
    return browser;
}
process.on("exit", async () => { try { await browser?.close(); } catch { } });

// ========= Concurrencia simple =========
let busy = false;

// ========= /render =========
app.post("/render", async (req, res) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    const t0 = Date.now();

    if (busy) return res.status(429).json({ error: "busy_try_again" });
    busy = true;

    let page;
    try {
        const { ast, data = {}, flags = [], cssTokens = {}, options = {} } = req.body || {};
        if (!ast || !Array.isArray(ast.blocks) || !ast.byBlock) {
            console.warn(`[render] 400 invalid_ast rid=${rid}`);
            return res.status(400).json({ error: "invalid_ast" });
        }

        // Inyecta base pública de assets si no viene del cliente
        if (!data.__assetsBase) data.__assetsBase = ASSETS_PUBLIC_BASE || "";

        // Construir HTML
        const html = buildHtml({ ast, data, flags, cssTokens, options });

        // Render con navegador persistente
        const br = await getBrowser();
        page = await br.newPage();
        page.setDefaultTimeout(300000);
        page.setDefaultNavigationTimeout(300000);
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

        await page.setContent(html, { waitUntil: "load", timeout: 300000 });

        // Esperar fuentes
        try { await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())); } catch { }

        // Esperar imágenes hasta 15s máx
        await page.evaluate(async (maxWaitMs) => {
            const imgs = Array.from(document.images || []);
            const waitOne = (img) =>
                img.complete
                    ? Promise.resolve()
                    : new Promise((resolve) => {
                        const done = () => resolve();
                        img.addEventListener("load", done, { once: true });
                        img.addEventListener("error", done, { once: true });
                    });
            const all = Promise.all(imgs.map(waitOne));
            await Promise.race([all, new Promise((r) => setTimeout(r, maxWaitMs))]);
        }, 15000);

        const pdfOpts = {
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            timeout: 300000,
            scale: options.scale ?? 0.9,
            ...(options.pdf || {}),
        };

        const pdf = await page.pdf(pdfOpts);

        const mu = process.memoryUsage();
        console.log(
            `[render] -> 200 pdf_bytes=${pdf.length} rss=${mu.rss} heapUsed=${mu.heapUsed} durMs=${Date.now() - t0} rid=${rid}`
        );

        return res.json({
            pdf_base64: Buffer.from(pdf).toString("base64"),
            ...(process.env.RETURN_HTML === "1" ? { html_debug: html } : {}),
        });
    } catch (e) {
        console.error(`[render][ERROR] rid=${rid} ${e?.stack || String(e)}`);
        return res.status(500).json({ error: "render_failed" });
    } finally {
        try { await page?.close(); } catch { }
        busy = false;
    }
});

// ========= Shutdown =========
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("unhandledRejection", (err) => {
    console.error("[render][unhandledRejection]", err);
});

// ========= Start =========
app.listen(PORT, () => console.log("renderer listening on", PORT));