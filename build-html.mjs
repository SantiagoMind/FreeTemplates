// Renderer HTML a partir de un AST declarativo.
// Soporta components: text | image | table | kv
// Photogrid: agrupa caption+image en 3 columnas (configurable)

export function buildHtml({ ast, data = {}, flags = [], cssTokens = {}, options = {} }) {
    const flagSet = new Set(flags);
    const styleMap = mapStyles(ast.styles || []);
    const tokensCss = buildTokensCss(cssTokens);

    const page = normalizePage(options.page || {});
    const baseCss = `
  <style>
    @page { size: ${page.size}; margin: ${page.marginTop} ${page.marginRight} ${page.marginBottom} ${page.marginLeft}; }
    :root { ${tokensCss} }
    html, body { padding:0; margin:0; font-family: var(--font, Roboto, Arial, sans-serif); color:#111; }

    section.sec { break-inside:auto; page-break-inside:auto; margin:0 0 var(--block-gap, 6mm) 0; }
    section.sec-header { margin-bottom: 3mm; }
    section.sec-general { margin-bottom: 5mm; }
    .pb { page-break-before: always; }

    .text { font-size: 11pt; line-height: 1.25; }

    /* ===== Tabla genérica ===== */
    table.tbl { width:100%; border-collapse: collapse; table-layout: fixed; page-break-inside:auto; break-inside:auto; }
    table.tbl tr { page-break-inside: avoid; break-inside: avoid; }
    table.tbl th, table.tbl td { border: 1px solid #ddd; padding: 4pt; word-wrap: break-word; font-size: 10pt; }
    table.tbl thead th { background: #f5f5f5; font-weight: 600; }

    .placeholder { color:#777; font-style: italic; }

    /* ===== Photogrid ===== */
    .pg-grid {
      display:grid;
      grid-template-columns: repeat(var(--pg-cols, 3), 1fr);
      gap: var(--pg-gap, 6mm);
      align-items: start;
    }
    .pg-tile { display:flex; flex-direction:column; align-items:center; break-inside:avoid; page-break-inside:avoid; }
    .pg-caption {
      font-size: var(--pg-cap-size, 10pt);
      font-weight: var(--pg-cap-weight, 700);
      text-align: var(--pg-cap-align, center);
      margin: 0 0 2mm 0;
    }
    .pg-image {
      max-width: 100%;
      max-height: var(--pg-img-h, 170px);
      object-fit: var(--pg-img-fit, contain);
    }

    /* ===== Key-Value grid (General Information sin tabla) ===== */
    .kv-grid {
      display: grid;
      grid-template-columns: repeat(var(--kv-cols, 2), 1fr);
      gap: var(--kv-gap, 4mm);
      align-items: start;
    }
    .kv-item {
      border: 1px solid #e6e6e6;
      border-radius: 4px;
      padding: 4mm;
      break-inside: avoid;
      page-break-inside: avoid;
      background: #fff;
    }
    .kv-label {
      font-size: 8.5pt;
      color: #666;
      letter-spacing: .02em;
      text-transform: uppercase;
      margin: 0 0 1.5mm 0;
    }
    .kv-value {
      font-size: 11pt;
      font-weight: 600;
      color: #111;
      word-wrap: break-word;
    }
    /* Variante compacta sin caja */
    .kv-compact .kv-item {
      border: none;
      padding: 0;
    }
    .kv-compact .kv-label {
      font-weight: 600;
      text-transform: none;
      color: #555;
      margin-bottom: .5mm;
    }
    .kv-compact .kv-value {
      font-weight: 400;
    }

    ${stylesToCss(styleMap)}
  </style>`;

    let body = "";

    for (const b of (ast.blocks || [])) {
        const secClasses = ["sec", `sec-${cssClassSafe(b.block_id || "block")}`];
        if (b.page_break_before) secClasses.push("pb");
        body += `<section class="${secClasses.join(" ")}">`;

        const comps = ast.byBlock?.[b.block_id] || [];

        // Photogrid solo para el bloque "photos" si existe estilo "photogrid"
        if ((b.block_id || "").toLowerCase() === "photos" && styleMap.photogrid) {
            body += renderPhotoGrid(comps, { data, styleMap, flagSet, ast });
        } else {
            for (const c of comps) {
                const html = renderComponent(c, { data, styleMap, flagSet, ast });
                if (html) body += html;
            }
        }

        body += `</section>`;
    }

    return `<!doctype html><html><head><meta charset="utf-8">${baseCss}</head><body>${body}</body></html>`;
}

/* ==================== Photogrid ==================== */

function renderPhotoGrid(comps, ctx) {
    const pg = ctx.styleMap.photogrid || {};
    const cols = pg.columns || 3;
    const gap = cssNumber(pg.gap || "8mm");
    const imgH = cssNumber(pg.image_max_height || "170px");
    const imgFit = pg.image_fit || "contain";
    const capAlign = (pg.caption_align || "center");
    const capSize = (pg.caption_size != null ? `${Number(pg.caption_size)}pt` : "10pt");
    const capWeight = (pg.caption_weight === "bold" ? "700" : "700");

    // hacer pares caption+image respetando el orden en comps
    const tiles = [];
    for (let i = 0; i < comps.length; i++) {
        const c1 = comps[i];
        const c2 = comps[i + 1];

        let cap = "", src = "";

        if (c1?.type === "text" && c2?.type === "image") {
            cap = bindText(c1.binding, ctx.data);
            src = bindImageUrl(c2.binding, ctx.data);
            i++;
        } else if (c1?.type === "image" && c2?.type === "text") {
            src = bindImageUrl(c1.binding, ctx.data);
            cap = bindText(c2.binding, ctx.data);
            i++;
        } else if (c1?.type === "text") {
            cap = bindText(c1.binding, ctx.data);
        } else if (c1?.type === "image") {
            src = bindImageUrl(c1.binding, ctx.data);
        }

        if (!cap && !src) continue;
        const capHtml = cap ? `<div class="pg-caption">${escapeHtml(cap)}</div>` : `<div class="pg-caption"></div>`;
        const imgHtml = src ? `<img class="pg-image" src="${escapeAttr(src)}" />` : "";
        tiles.push(`<div class="pg-tile">${capHtml}${imgHtml}</div>`);
    }

    const styleVars =
        `style="--pg-cols:${cols};--pg-gap:${gap};--pg-img-h:${imgH};--pg-img-fit:${cssValue(imgFit)};` +
        `--pg-cap-align:${cssValue(capAlign)};--pg-cap-size:${capSize};--pg-cap-weight:${capWeight};"`;

    return `<div class="pg-grid" ${styleVars}>${tiles.join("")}</div>`;
}

/* ==================== Components ==================== */

function renderComponent(c, ctx) {
    switch ((c.type || "").toLowerCase()) {
        case "text": return renderText(c, ctx);
        case "image": return renderImage(c, ctx);
        case "table": return renderTableComponent(c, ctx);
        case "kv": return renderKVComponent(c, ctx);
        default: return "";
    }
}

function renderText(c, { data, styleMap }) {
    const val = bindText(c.binding, data);
    const hasValue = !!trimmed(val);
    const mode = (c.placeholderMode || "hidden").toLowerCase();
    const style = classFor(c.style_id, styleMap, ["text"]);
    if (!hasValue) {
        if (mode === "visible") {
            const txt = escapeHtml(c.placeholderText || "N/D");
            const phClass = classFor(c.placeholderStyle || "", styleMap, ["placeholder"]);
            return `<div class="${phClass}">${txt}</div>`;
        }
        return "";
    }
    return `<div class="${style}">${escapeHtml(val)}</div>`;
}

function renderImage(c, { data, styleMap }) {
    const url = bindImageUrl(c.binding, data);
    const fit = (c.image_fit || lookupStyle(styleMap, c.style_id, "image_fit") || "contain");
    const maxW = cssNumber(c.max_width || lookupStyle(styleMap, c.style_id, "max_width") || "100%");
    const maxH = cssNumber(c.max_height || lookupStyle(styleMap, c.style_id, "max_height") || "220px");
    const style = `style="max-width:${maxW};max-height:${maxH};object-fit:${fit}"`;

    if (!url) {
        const mode = (c.placeholderMode || "hidden").toLowerCase();
        if (mode === "visible") {
            const phClass = classFor(c.placeholderStyle || "", styleMap, ["placeholder"]);
            return `<div class="${phClass}">Imagen no disponible</div>`;
        }
        return "";
    }
    return `<img src="${escapeAttr(url)}" ${style} />`;
}

function renderTableComponent(c, { data, styleMap }) {
    const key = tableKey(c.binding);
    const rows = Array.isArray(data?.[key]) ? data[key] : [];
    if (!rows.length) {
        const mode = (c.placeholderMode || "hidden").toLowerCase();
        if (mode === "visible") {
            const phClass = classFor(c.placeholderStyle || "", styleMap, ["placeholder"]);
            return `<div class="${phClass}">Tabla vacía</div>`;
        }
        return "";
    }
    const headers = Array.isArray(c.headers) && c.headers.length ? c.headers : rows[0].map((_, i) => `Col ${i + 1}`);
    const dataRows = (c.headers ? rows : rows.slice(1));

    const cls = classFor(c.style_id, styleMap, ["tbl"]);
    const thead = `<thead><tr>${headers.map(h => `<th>${escapeHtml(String(h))}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${dataRows.map(r => `<tr>${r.map(cell => `<td>${escapeHtml(cell ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<table class="${cls}">${thead}${tbody}</table>`;
}

/* ====== Nuevo: Key-Value renderer ====== */
/**
 * c.type = "kv"
 * c.binding = "{{table:GeneralInfo}}"
 * Opcionales:
 *   c.label_col_index (default 0)
 *   c.value_col_index (default 1)
 *   c.columns (override de columnas)
 *   c.gap (override de gap, ej "4mm")
 *   c.variant = "boxed" | "compact"
 */
function renderKVComponent(c, { data, styleMap }) {
    const key = tableKey(c.binding);
    const rows = Array.isArray(data?.[key]) ? data[key] : [];
    if (!rows.length) {
        const mode = (c.placeholderMode || "hidden").toLowerCase();
        if (mode === "visible") {
            const phClass = classFor(c.placeholderStyle || "", styleMap, ["placeholder"]);
            return `<div class="${phClass}">Sin información</div>`;
        }
        return "";
    }

    // Si no se pasan headers, asumimos primera fila como encabezado y la omitimos.
    const dataRows = (c.headers ? rows : rows.slice(1));
    const li = Number.isInteger(c.label_col_index) ? c.label_col_index : 0;
    const vi = Number.isInteger(c.value_col_index) ? c.value_col_index : 1;

    const st = styleMap[c.style_id] || {};
    const cols = c.columns || st.columns || 2;
    const gap = cssNumber(c.gap || st.gap || "4mm");
    const variant = (c.variant || st.variant || "boxed").toLowerCase();
    const extraCls = variant === "compact" ? "kv-compact" : "";

    const items = dataRows.map(r => {
        const label = escapeHtml(safeStr(r[li] ?? ""));
        const value = escapeHtml(safeStr(r[vi] ?? ""));
        if (!label && !value) return "";
        return `<div class="kv-item"><div class="kv-label">${label}</div><div class="kv-value">${value}</div></div>`;
    }).join("");

    return `<div class="kv-grid ${extraCls}" style="--kv-cols:${cols};--kv-gap:${gap}">${items}</div>`;
}

/* ==================== Bindings helpers ==================== */

function bindText(tpl, map) {
    if (!tpl) return "";
    return tpl.replace(/\{\{col:([^}]+)\}\}/g, (_, k) => safeStr(map?.[k]));
}

function bindImageUrl(tpl, map) {
    const m = /\{\{img:([^}]+)\}\}/.exec(tpl || "");
    if (!m) return "";
    const raw = String(map?.[m[1]] || "").trim();
    if (!raw) return "";

    // artifact (asset:<id>)
    if (/^asset:/i.test(raw)) {
        const id = raw.slice(6);
        const base = (map.__assetsBase || "").replace(/\/+$/, "");
        return base ? `${base}/assets/${encodeURIComponent(id)}` : `/assets/${encodeURIComponent(id)}`;
    }

    // data URI directa
    if (/^data:/i.test(raw)) return raw;

    // URL -> intenta Drive
    if (/^https?:\/\//i.test(raw)) {
        const id =
            (/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]) ||
            (/drive\.google\.com\/uc\?(?:[^#]*&)?id=([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]) ||
            (/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]);
        if (id) return `https://drive.usercontent.google.com/uc?export=download&id=${id}`;
        return raw;
    }

    // ID Drive
    if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) {
        return `https://drive.usercontent.google.com/uc?export=download&id=${raw}`;
    }

    return "";
}

function tableKey(tpl) {
    const m = /\{\{table:([^}]+)\}\}/.exec(tpl || "");
    return m ? m[1] : "";
}

/* ==================== Styles ==================== */

function mapStyles(styles) {
    const map = {};
    for (const s of styles) {
        if (!s?.style_id) continue;
        map[s.style_id] = s;
    }
    return map;
}
function stylesToCss(styleMap) {
    let out = "";
    for (const [key, s] of Object.entries(styleMap)) {
        const cls = `.s-${cssClassSafe(key)}`;
        const font = s.font ? `font-family:${cssValue(s.font)};` : "";
        const size = s.size ? `font-size:${Number(s.size)}pt;` : "";
        const weight = s.weight === "bold" ? "font-weight:700;" : "";
        const align = s.align ? `text-align:${cssValue(s.align)};` : "";
        const color = s.color ? `color:${cssValue(s.color)};` : "";
        const lh = s.line_height ? `line-height:${cssNumber(s.line_height)};` : "";
        const bg = s.bg ? `background:${cssValue(s.bg)};` : "";
        const pad = s.padding ? `padding:${cssNumber(s.padding)};` : "";
        const bor = s.border ? `border:${cssValue(s.border)};` : "";
        const width = s.width ? `width:${cssNumber(s.width)};` : "";
        const maxW = s.max_width ? `max-width:${cssNumber(s.max_width)};` : "";
        const maxH = s.max_height ? `max-height:${cssNumber(s.max_height)};` : "";
        const imgFit = s.image_fit ? `object-fit:${cssValue(s.image_fit)};` : "";
        out += `${cls}{${font}${size}${weight}${align}${color}${lh}${bg}${pad}${bor}${width}${maxW}${maxH}${imgFit}}\n`;
    }
    return out;
}

function classFor(styleId, styleMap, base = []) {
    const classes = [...base];
    if (styleId && styleMap[styleId]) classes.push(`s-${cssClassSafe(styleId)}`);
    return classes.join(" ").trim();
}

function lookupStyle(styleMap, styleId, key) {
    const s = styleMap?.[styleId];
    return s ? s[key] : undefined;
}

/* ==================== CSS helpers ==================== */

function buildTokensCss(tokens) {
    return Object.entries(tokens || {})
        .map(([k, v]) => `${k}:${String(v).replace(/;/g, "")};`)
        .join("");
}

function normalizePage(p) {
    return {
        size: p.size || "A4",
        marginTop: p.marginTop || "18mm",
        marginRight: p.marginRight || "18mm",
        marginBottom: p.marginBottom || "18mm",
        marginLeft: p.marginLeft || "18mm"
    };
}

/* ==================== Utils ==================== */

function safeStr(v) { return v == null ? "" : String(v); }
function trimmed(v) { return safeStr(v).trim(); }
function escapeHtml(s) {
    return safeStr(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function escapeAttr(s) { return escapeHtml(s).replaceAll("\n", " "); }
function cssClassSafe(s) { return safeStr(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function cssNumber(v) { return /^[0-9.]+(px|pt|mm|cm|%)?$/.test(String(v)) ? v : String(v); }
function cssValue(v) { return String(v); }