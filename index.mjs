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

        // 1) HTML base (sin inline de imágenes)
        const html = buildHtml({ ast, data, flags, cssTokens, options });

        // 2) Render PDF
        const browser = await puppeteer.launch({
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"]
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(120000);
        page.setDefaultNavigationTimeout(120000);

        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 120000 });

        // Espera a que todas las imágenes reporten load/error
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