import express from "express";
import puppeteer from "puppeteer";
import { buildHtml } from "./build-html.mjs";

const app = express();
app.use(express.json({ limit: "12mb" }));

// Seguridad simple por API Key
app.use((req, res, next) => {
    const key = process.env.API_KEY;
    if (!key) return next(); // sin key, sin validación (dev)
    if (req.headers["x-api-key"] !== key) return res.status(401).json({ error: "unauthorized" });
    next();
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/render", async (req, res) => {
    try {
        const { ast, data, flags = [], cssTokens = {}, options = {} } = req.body || {};
        if (!ast || !Array.isArray(ast.blocks) || !ast.byBlock) {
            return res.status(400).json({ error: "invalid_ast" });
        }

        // Construir HTML
        const html = buildHtml({ ast, data, flags, cssTokens, options });

        // Lanzar navegador
        const browser = await puppeteer.launch({
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--font-render-hinting=none"
            ]
        });
        const page = await browser.newPage();

        // Opcional: viewport no afectará printToPDF, pero ayuda al layout previo
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

        await page.setContent(html, { waitUntil: "networkidle0", timeout: 120000 });

        const pdf = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            timeout: 120000
        });

        await browser.close();

        res.json({
            pdf_base64: Buffer.from(pdf).toString("base64")
            // Puedes devolver html_debug si lo deseas:
            // , html_debug: process.env.RETURN_HTML === "1" ? html : undefined
        });
    } catch (e) {
        console.error("[render_failed]", e?.stack || String(e));
        res.status(500).json({ error: "render_failed" });
    }
});

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("renderer listening on", PORT));
