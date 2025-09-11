// index.mjs
import express from "express";
// puppeteer/buildHtml quedan importados por compatibilidad, pero /render se desactiva en este flujo
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

// Helpers de layout
function extractPhotoBindings(ast = {}) {
  const comps = ast?.byBlock?.photos || [];
  const items = [];
  for (let i = 0; i < comps.length; i += 2) {
    const img = comps[i];
    const cap = comps[i + 1];
    const mImg = /{{img:([^}]+)}}/.exec(img?.binding || "");
    const mCap = /{{col:([^}]+)}}/.exec(cap?.binding || "");
    if (mImg) items.push({ srcKey: mImg[1], capKey: mCap ? mCap[1] : null });
  }
  return items;
}
function extractTextCols(ast = {}) {
  const cols = new Set();
  const byBlock = ast?.byBlock || {};
  for (const blk of Object.values(byBlock)) {
    (blk || []).forEach((comp) => {
      const m = /{{col:([^}]+)}}/.exec(comp?.binding || "");
      if (m) cols.add(m[1]);
    });
  }
  return Array.from(cols);
}
function pickGrid(n) {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}
function buildRelativeBoxes(rows, cols, { margin = 0.05, gap = 0.02 } = {}) {
  const boxes = [];
  const totalGapW = gap * (cols - 1);
  const totalGapH = gap * (rows - 1);
  const innerW = 1 - margin * 2 - totalGapW;
  const innerH = 1 - margin * 2 - totalGapH;
  const cellW = innerW / cols;
  const cellH = innerH / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = margin + c * (cellW + gap);
      const y = margin + r * (cellH + gap);
      boxes.push({ x, y, w: cellW, h: cellH });
    }
  }
  return boxes;
}
function paginate(items, perPage) {
  const out = [];
  for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
  return out;
}

// Endpoint que devuelve texto a reemplazar y posiciones relativas de imágenes
app.post("/layout", async (req, res) => {
  const rid = req.headers["x-req-id"] || "no-req-id";
  const t0 = Date.now();
  try {
    const { ast = {}, data = {}, options = {} } = req.body || {};
    if (!ast?.byBlock) {
      console.warn(`[render] 400 invalid_ast rid=${rid}`);
      return res.status(400).json({ error: "invalid_ast" });
    }

    // Texto: mapa de {{col:KEY}} -> valor
    const colKeys = extractTextCols(ast);
    const textMap = {};
    colKeys.forEach((k) => (textMap[`{{col:${k}}}`] = data?.[k] ?? ""));

    // Imágenes: layout relativo
    const items = extractPhotoBindings(ast).map((it, i) => ({
      ...it,
      src: data?.[it.srcKey] || null,
      caption: it.capKey ? String(data?.[it.capKey] ?? "") : "",
      idx: i,
    }));
    const n = items.length;
    const grid = options.grid || pickGrid(n);
    const boxes = buildRelativeBoxes(grid.rows, grid.cols, {
      margin: options.margin ?? 0.05,
      gap: options.gap ?? 0.02,
    });
    const perPage = grid.rows * grid.cols;
    const pages = paginate(items, perPage);
    const slides = pages.map((chunk) => {
      const placements = [];
      for (let i = 0; i < chunk.length; i++) {
        const b = boxes[i];
        const it = chunk[i];
        placements.push({
          srcKey: it.srcKey,
          capKey: it.capKey,
          x_rel: b.x,
          y_rel: b.y,
          w_rel: b.w,
          h_rel: b.h,
          src: it.src,
          caption: it.caption,
          idx: it.idx,
        });
      }
      return { items: placements };
    });

    const payload = {
      unit: "relative",
      grid,
      per_slide: perPage,
      count: n,
      textMap,
      slides,
    };

    console.log(
      `[render] -> 200 layout slides=${slides.length} items=${n} durMs=${Date.now() - t0} rid=${rid}`
    );
    return res.json(payload);
  } catch (e) {
    console.error(`[render][ERROR] rid=${rid} ${e?.stack || String(e)}`);
    return res.status(500).json({ error: "layout_failed" });
  }
});

// Deshabilitar render HTML->PDF en este flujo
app.post("/render", (_req, res) => res.status(410).json({ error: "disabled_use_/layout" }));

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("unhandledRejection", (err) => console.error("[render][unhandledRejection]", err));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("renderer listening on", PORT));