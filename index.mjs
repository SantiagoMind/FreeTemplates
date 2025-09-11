// index.mjs — Render HTML->PDF (pdf_base64) compatible con tu GAS actual
import express from "express";
import puppeteer from "puppeteer";
import { buildHtml } from "./build-html.mjs";

const app = express();
// Acepta payloads grandes (data:URI de imágenes)
app.use(express.json({ limit: process.env.JSON_LIMIT || "64mb" }));

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
app.get("/", (_req, res) => res.status(200).send("ok"));
app.head("/", (_req, res) => res.status(200).end());

// Puppeteer singleton para evitar OOM/restarts
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

// Concurrencia: 1 en curso. Responder 429 si ocupado.
let busy = false;

// Endpoint principal: devuelve { pdf_base64 }
app.post("/render", async (req, res) => {
    const rid = req.headers["x-req-id"] || "no-req-id";
    const t0 = Date.now();

    if (busy) return res.status(429).json({ error: "busy_try_again" });
    busy = true;

    let page;
    try {
        const { ast, data, flags = [], cssTokens = {}, options = {} } = req.body || {};
        if (!ast || !Array.isArray(ast.blocks) || !ast.byBlock) {
            console.warn(`[render] 400 invalid_ast rid=${rid}`);
            return res.status(400).json({ error: "invalid_ast" });
        }

        // 1) Construir HTML desde AST/DATA (imágenes esperadas como data:URI o URLs públicas)
        const html = buildHtml({ ast, data, flags, cssTokens, options });

        // 2) Render con navegador persistente
        const br = await getBrowser();
        page = await br.newPage();
        page.setDefaultTimeout(300000);
        page.setDefaultNavigationTimeout(300000);
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

        // Menos sensible a redes lentas que "networkidle0"
        await page.setContent(html, { waitUntil: "load", timeout: 300000 });

        // Esperar fuentes (si existen)
        try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { }

        // Espera acotada para imágenes: load/error o timeout global
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
            scale: options.scale ?? 0.9, // ayuda a bajar presión de raster
        };

        const pdf = await page.pdf({ ...pdfOpts, ...(options.pdf || {}) });

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

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("unhandledRejection", (err) => {
    console.error("[render][unhandledRejection]", err);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("renderer listening on", PORT));