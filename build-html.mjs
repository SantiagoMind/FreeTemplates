// Renderer HTML a partir de un AST declarativo.
// Soporta components: text | image | table
// Placeholders visibles u ocultos por componente.
// Estilos declarativos a clases CSS.

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
    section { break-inside: avoid; }
    .pb { page-break-before: always; }

    /* texto base */
    .text { font-size: 11pt; line-height: 1.25; }

    /* tabla base */
    table.tbl { width:100%; border-collapse: collapse; table-layout: fixed; }
    table.tbl th, table.tbl td { border: 1px solid #ddd; padding: 4pt; word-wrap: break-word; font-size: 10pt; }
    table.tbl thead th { background: #f5f5f5; font-weight: 600; }

    /* placeholder */
    .placeholder { color:#777; font-style: italic; }

    /* estilos generados */
    ${stylesToCss(styleMap)}

  </style>`;

    let body = "";

    for (const b of (ast.blocks || [])) {
        body += `<section class="${b.page_break_before ? "pb" : ""}">`;

        const comps = ast.byBlock?.[b.block_id] || [];
        for (const c of comps) {
            const html = renderComponent(c, { data, styleMap, flagSet, ast });
            if (html) body += html;
        }

        body += `</section>`;
    }

    return `<!doctype html><html><head><meta charset="utf-8">${baseCss}</head><body>${body}</body></html>`;
}

/* ==================== Components ==================== */

function renderComponent(c, ctx) {
    switch ((c.type || "").toLowerCase()) {
        case "text": return renderText(c, ctx);
        case "image": return renderImage(c, ctx);
        case "table": return renderTableComponent(c, ctx);
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

    // URL ? intenta extraer ID si es de Drive
    if (/^https?:\/\//i.test(raw)) {
        const id =
            (/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]) ||
            (/drive\.google\.com\/uc\?(?:[^#]*&)?id=([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]) ||
            (/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/i.exec(raw)?.[1]);
        if (id) return `https://lh3.googleusercontent.com/d/${id}=s0`; // tamaño explícito evita 400
        return raw;
    }

    // ID puro
    if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) {
        return `https://lh3.googleusercontent.com/d/${raw}=s0`;
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
        out += `${cls}{${font}${size}${weight}${align}${color}${lh}${bg}${pad}${bor}}\n`;
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