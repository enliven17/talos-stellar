export const dynamic = "force-dynamic";

export function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TALOS Stellar API — Reference</title>
  <meta name="description" content="Interactive REST API documentation for the TALOS Protocol." />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/maple-mono/index.min.css" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    /* ── TALOS app theme — matches globals.css ── */
    :root {
      --bg:      #FCF8F8;
      --surface: #FBEFEF;
      --border:  #F9DFDF;
      --accent:  #F5AFAF;
      --fg:      #2D2D2D;
      --muted:   #8E8383;
      --font:    "Maple Mono", ui-monospace, monospace;

      /* method badge palette — all within the pink family */
      --get-bg:    #FDF3F3; --get-fg:    #C46B6B; --get-bd:    #ECC0C0;
      --post-bg:   #F8F0F8; --post-fg:   #9B6B9B; --post-bd:   #DEC0DE;
      --put-bg:    #F8F4EC; --put-fg:    #8B7040; --put-bd:    #DED0A8;
      --patch-bg:  #F0F4F8; --patch-fg:  #4B6B8B; --patch-bd:  #B0C8E0;
      --delete-bg: #FFF0F0; --delete-fg: #B04040; --delete-bd: #E8A8A8;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
    }

    /* ── custom nav bar ── */
    #tls-header {
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      height: 52px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    #tls-header .logo {
      font-family: var(--font);
      font-size: 15px;
      font-weight: 700;
      color: var(--accent);
      text-decoration: none;
    }
    #tls-header .sep { color: var(--border); }
    #tls-header .badge { color: var(--muted); font-size: 13px; }
    #tls-header nav { margin-left: auto; display: flex; gap: 16px; }
    #tls-header nav a {
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      font-family: var(--font);
      padding: 4px 10px;
      border: 1px solid transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    #tls-header nav a:hover { color: var(--fg); border-color: var(--border); }

    /* ── hide default swagger topbar ── */
    .swagger-ui .topbar { display: none !important; }

    /* ── global resets ── */
    .swagger-ui, .swagger-ui * {
      font-family: var(--font) !important;
      border-radius: 0 !important;
    }
    .swagger-ui { background: var(--bg) !important; color: var(--fg) !important; }
    .swagger-ui .wrapper { max-width: 1100px; padding: 0 24px; }

    /* ── info block ── */
    .swagger-ui .info { margin: 32px 0 24px; }
    .swagger-ui .info .title { color: var(--fg) !important; font-size: 22px !important; }
    .swagger-ui .info .title small { background: var(--accent) !important; color: #fff !important; border-radius: 4px !important; }
    .swagger-ui .info a, .swagger-ui .info a:visited { color: var(--accent) !important; }
    .swagger-ui .info .description p,
    .swagger-ui .info .description li { color: var(--muted) !important; font-size: 13px !important; line-height: 1.6; }
    .swagger-ui .info .description h2 { color: var(--fg) !important; font-size: 14px !important; border-bottom: 1px solid var(--border); padding-bottom: 4px; margin-top: 20px; }
    .swagger-ui .info .description strong { color: var(--fg) !important; }
    .swagger-ui .info .description code {
      background: var(--surface) !important; border: 1px solid var(--border) !important;
      color: var(--accent) !important; padding: 1px 5px; font-size: 12px;
    }
    .swagger-ui .info .description pre {
      background: var(--surface) !important; border: 1px solid var(--border) !important;
      padding: 10px 14px; overflow-x: auto; margin: 8px 0;
    }
    .swagger-ui .info .description pre code { background: none !important; border: none !important; padding: 0; }

    /* ── server selector + auth bar ── */
    .swagger-ui .scheme-container {
      background: var(--surface) !important;
      border: 1px solid var(--border) !important;
      border-left: none; border-right: none;
      padding: 12px 0;
      box-shadow: none !important;
    }
    .swagger-ui .schemes label,
    .swagger-ui .schemes select { color: var(--fg) !important; }
    .swagger-ui .schemes select {
      background: var(--bg) !important;
      border: 1px solid var(--border) !important;
      color: var(--fg) !important;
    }
    .swagger-ui .auth-wrapper .authorize {
      background: var(--accent) !important;
      color: #fff !important;
      border: none !important;
      padding: 6px 18px !important;
      font-weight: 600 !important;
      cursor: pointer;
    }
    .swagger-ui .auth-wrapper .authorize svg { fill: #fff !important; }
    .swagger-ui .auth-wrapper .authorize:hover { opacity: 0.85; }

    /* ── tag section headers ── */
    .swagger-ui .opblock-tag {
      background: var(--bg) !important;
      border: none !important;
      border-bottom: 1px solid var(--border) !important;
      color: var(--fg) !important;
      font-size: 15px !important;
      font-weight: 700 !important;
      padding: 14px 0 !important;
      margin-top: 12px !important;
    }
    .swagger-ui .opblock-tag small { color: var(--muted) !important; font-size: 12px !important; font-weight: 400 !important; }
    .swagger-ui .opblock-tag:hover { background: var(--surface) !important; }
    .swagger-ui .opblock-tag svg { fill: var(--muted) !important; }

    /* ── operation rows ── */
    .swagger-ui .opblock {
      background: var(--bg) !important;
      border: 1px solid var(--border) !important;
      box-shadow: none !important;
      margin-bottom: 4px !important;
    }
    .swagger-ui .opblock.is-open { border-color: var(--accent) !important; }
    .swagger-ui .opblock-summary { padding: 8px 12px !important; }
    .swagger-ui .opblock-summary:hover { background: var(--surface) !important; }
    .swagger-ui .opblock-summary-path {
      color: var(--fg) !important;
      font-size: 13px !important;
    }
    .swagger-ui .opblock-summary-path .view-line-link { display: none; }
    .swagger-ui .opblock-summary-description {
      color: var(--muted) !important;
      font-size: 12px !important;
    }
    .swagger-ui .opblock-summary svg { fill: var(--muted) !important; }

    /* ── method badges ── */
    .swagger-ui .opblock-summary-method {
      font-size: 11px !important; font-weight: 700 !important;
      min-width: 64px !important; text-align: center !important;
      padding: 4px 0 !important; letter-spacing: 0.05em;
    }
    .swagger-ui .opblock-get    .opblock-summary-method { background: var(--get-bg)    !important; color: var(--get-fg)    !important; border: 1px solid var(--get-bd)    !important; }
    .swagger-ui .opblock-post   .opblock-summary-method { background: var(--post-bg)   !important; color: var(--post-fg)   !important; border: 1px solid var(--post-bd)   !important; }
    .swagger-ui .opblock-put    .opblock-summary-method { background: var(--put-bg)    !important; color: var(--put-fg)    !important; border: 1px solid var(--put-bd)    !important; }
    .swagger-ui .opblock-patch  .opblock-summary-method { background: var(--patch-bg)  !important; color: var(--patch-fg)  !important; border: 1px solid var(--patch-bd)  !important; }
    .swagger-ui .opblock-delete .opblock-summary-method { background: var(--delete-bg) !important; color: var(--delete-fg) !important; border: 1px solid var(--delete-bd) !important; }

    /* ── expanded operation body ── */
    .swagger-ui .opblock-body { background: var(--surface) !important; border-top: 1px solid var(--border) !important; }
    .swagger-ui .opblock-section-header {
      background: var(--surface) !important;
      border-bottom: 1px solid var(--border) !important;
      box-shadow: none !important;
    }
    .swagger-ui .opblock-section-header h4 { color: var(--fg) !important; font-size: 12px !important; }
    .swagger-ui .opblock-description-wrapper p,
    .swagger-ui .opblock-description-wrapper li { color: var(--muted) !important; font-size: 13px !important; }
    .swagger-ui .opblock-description-wrapper code {
      background: var(--bg) !important; border: 1px solid var(--border) !important;
      color: var(--accent) !important; padding: 1px 4px; font-size: 12px;
    }
    .swagger-ui .opblock-description-wrapper pre {
      background: var(--bg) !important; border: 1px solid var(--border) !important;
      padding: 10px; overflow-x: auto;
    }
    .swagger-ui .opblock-description-wrapper strong { color: var(--fg) !important; }

    /* ── params / request body ── */
    .swagger-ui table thead tr th,
    .swagger-ui table thead tr td { color: var(--muted) !important; font-size: 11px !important; border-bottom: 1px solid var(--border) !important; }
    .swagger-ui .parameter__name { color: var(--fg) !important; }
    .swagger-ui .parameter__type { color: var(--muted) !important; font-size: 11px !important; }
    .swagger-ui .parameter__in { color: var(--accent) !important; font-size: 10px !important; }
    .swagger-ui .parameter__deprecated { color: var(--muted) !important; }
    .swagger-ui .required { color: var(--accent) !important; }
    .swagger-ui textarea, .swagger-ui input[type=text], .swagger-ui input[type=email], .swagger-ui input[type=password] {
      background: var(--bg) !important; border: 1px solid var(--border) !important;
      color: var(--fg) !important; padding: 6px 10px !important; font-size: 13px !important;
    }
    .swagger-ui textarea:focus, .swagger-ui input:focus { border-color: var(--accent) !important; outline: none !important; }
    .swagger-ui select {
      background: var(--bg) !important; border: 1px solid var(--border) !important;
      color: var(--fg) !important;
    }

    /* ── buttons ── */
    .swagger-ui .btn {
      font-family: var(--font) !important; font-size: 12px !important;
      border-radius: 0 !important; padding: 5px 14px !important;
    }
    .swagger-ui .btn.execute {
      background: var(--accent) !important; color: #fff !important;
      border: none !important; font-weight: 600 !important;
    }
    .swagger-ui .btn.execute:hover { opacity: 0.85; }
    .swagger-ui .btn.btn-clear {
      color: var(--muted) !important; border: 1px solid var(--border) !important;
      background: transparent !important;
    }
    .swagger-ui .try-out__btn {
      color: var(--accent) !important; border-color: var(--accent) !important;
      background: transparent !important;
    }
    .swagger-ui .copy-to-clipboard button {
      background: var(--surface) !important; border: 1px solid var(--border) !important;
    }

    /* ── responses ── */
    .swagger-ui .responses-inner { background: var(--bg) !important; }
    .swagger-ui .response-col_status { color: var(--fg) !important; font-size: 13px !important; }
    .swagger-ui .response-col_description p { color: var(--muted) !important; font-size: 13px !important; }
    .swagger-ui table.responses-table { border: 1px solid var(--border) !important; }
    .swagger-ui table.responses-table tr { border-bottom: 1px solid var(--border) !important; }
    .swagger-ui .highlight-code { background: var(--surface) !important; border: 1px solid var(--border) !important; }
    .swagger-ui .microlight { background: var(--surface) !important; }

    /* ── models section ── */
    .swagger-ui section.models {
      background: var(--bg) !important;
      border: 1px solid var(--border) !important;
      margin-top: 24px;
    }
    .swagger-ui section.models h4 { color: var(--fg) !important; font-size: 14px !important; }
    .swagger-ui section.models .model-container { background: var(--surface) !important; border: 1px solid var(--border) !important; }
    .swagger-ui .model-box { background: var(--surface) !important; }
    .swagger-ui .model .property { color: var(--fg) !important; }
    .swagger-ui .model .property.primitive { color: var(--muted) !important; }
    .swagger-ui .prop-type { color: var(--accent) !important; }
    .swagger-ui .prop-format { color: var(--muted) !important; }
    .swagger-ui .model-toggle { background: var(--accent) !important; }

    /* ── auth modal ── */
    .swagger-ui .dialog-ux .modal-ux-header { background: var(--surface) !important; border-bottom: 1px solid var(--border) !important; }
    .swagger-ui .dialog-ux .modal-ux-header h3 { color: var(--fg) !important; }
    .swagger-ui .dialog-ux .modal-ux { background: var(--bg) !important; border: 1px solid var(--border) !important; }
    .swagger-ui .auth-container h4 { color: var(--fg) !important; border-bottom: 1px solid var(--border) !important; }
    .swagger-ui .auth-container label { color: var(--muted) !important; font-size: 12px !important; }
    .swagger-ui .auth-container p { color: var(--muted) !important; font-size: 12px !important; }
    .swagger-ui .auth-container code { color: var(--accent) !important; }
    .swagger-ui .dialog-ux .modal-ux-content .btn { margin-top: 8px; }

    /* ── misc ── */
    .swagger-ui .loading-container .loading::after { border-color: var(--accent) transparent !important; }
    .swagger-ui hr { border-color: var(--border) !important; }
    .swagger-ui .tab li { color: var(--muted) !important; }
    .swagger-ui .tab li.active { color: var(--fg) !important; border-bottom: 2px solid var(--accent) !important; }
    ::selection { background: rgba(245, 175, 175, 0.25); }
  </style>
</head>
<body>

  <div id="tls-header">
    <a class="logo" href="/">[TALOS]</a>
    <span class="sep">|</span>
    <span class="badge">API Reference</span>
    <nav>
      <a href="/docs">← Dev Docs</a>
      <a href="/api/docs/openapi.json">OpenAPI JSON</a>
    </nav>
  </div>

  <div id="swagger-ui"></div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/api/docs/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 2,
      displayRequestDuration: true,
      tryItOutEnabled: false,
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
