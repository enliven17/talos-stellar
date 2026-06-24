export const dynamic = "force-dynamic";

export function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TALOS Stellar API — Reference</title>
  <meta name="description" content="Interactive REST API documentation for the TALOS Protocol." />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    /* ── TALOS dark-mode skin ── */
    :root {
      --tls-bg: #0a0a0a;
      --tls-surface: #111111;
      --tls-border: #1f1f1f;
      --tls-accent: #39ff14;
      --tls-fg: #e0e0e0;
      --tls-muted: #666;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--tls-bg); color: var(--tls-fg); font-family: monospace; }

    /* topbar */
    .swagger-ui .topbar { background: var(--tls-surface); border-bottom: 1px solid var(--tls-border); padding: 8px 20px; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }

    /* section titles */
    .swagger-ui .opblock-tag { background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important; color: var(--tls-fg) !important; font-family: monospace !important; }
    .swagger-ui .opblock-tag:hover { background: var(--tls-border) !important; }

    /* operation blocks */
    .swagger-ui .opblock { background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important; border-radius: 0 !important; margin-bottom: 4px !important; }
    .swagger-ui .opblock .opblock-summary-method { border-radius: 0 !important; font-family: monospace !important; font-weight: 700 !important; min-width: 72px !important; }
    .swagger-ui .opblock .opblock-summary-path { color: var(--tls-fg) !important; font-family: monospace !important; }
    .swagger-ui .opblock .opblock-summary-description { color: var(--tls-muted) !important; font-family: monospace !important; }

    /* body / schema */
    .swagger-ui .opblock-body, .swagger-ui .opblock-section { background: var(--tls-bg) !important; }
    .swagger-ui textarea, .swagger-ui input[type=text], .swagger-ui input[type=email] {
      background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important;
      color: var(--tls-fg) !important; font-family: monospace !important; border-radius: 0 !important;
    }
    .swagger-ui .btn { border-radius: 0 !important; font-family: monospace !important; }
    .swagger-ui .btn.execute { background: var(--tls-accent) !important; color: #000 !important; border: none !important; font-weight: 700 !important; }
    .swagger-ui .btn.execute:hover { opacity: 0.85; }
    .swagger-ui .btn.cancel { border: 1px solid var(--tls-border) !important; color: var(--tls-muted) !important; }

    /* scheme badge colours */
    .swagger-ui .opblock-get    .opblock-summary-method { background: #1a3a1a !important; color: var(--tls-accent) !important; border: 1px solid var(--tls-accent) !important; }
    .swagger-ui .opblock-post   .opblock-summary-method { background: #1a2a3a !important; color: #4fc3f7 !important; border: 1px solid #4fc3f7 !important; }
    .swagger-ui .opblock-put    .opblock-summary-method { background: #2a2a1a !important; color: #ffb74d !important; border: 1px solid #ffb74d !important; }
    .swagger-ui .opblock-patch  .opblock-summary-method { background: #2a1a2a !important; color: #ce93d8 !important; border: 1px solid #ce93d8 !important; }
    .swagger-ui .opblock-delete .opblock-summary-method { background: #3a1a1a !important; color: #ef9a9a !important; border: 1px solid #ef9a9a !important; }

    /* response codes */
    .swagger-ui .response-col_status { color: var(--tls-accent) !important; font-family: monospace !important; }
    .swagger-ui table.responses-table .col_description p { color: var(--tls-fg) !important; }

    /* auth modal */
    .swagger-ui .dialog-ux .modal-ux { background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important; }
    .swagger-ui .auth-container h4, .swagger-ui .auth-container label { color: var(--tls-fg) !important; font-family: monospace !important; }
    .swagger-ui .auth-container .wrapper input { background: var(--tls-bg) !important; border: 1px solid var(--tls-border) !important; color: var(--tls-fg) !important; }

    /* misc */
    .swagger-ui .info .title { color: var(--tls-accent) !important; font-family: monospace !important; }
    .swagger-ui .info .description p, .swagger-ui .info .description li { color: var(--tls-fg) !important; }
    .swagger-ui .info .description code { background: var(--tls-border) !important; color: var(--tls-accent) !important; padding: 1px 4px; }
    .swagger-ui .info .description pre { background: var(--tls-border) !important; padding: 8px; overflow-x: auto; }
    .swagger-ui select { background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important; color: var(--tls-fg) !important; }
    .swagger-ui .model-box, .swagger-ui .model { background: var(--tls-surface) !important; }
    .swagger-ui .model .property { color: var(--tls-fg) !important; }
    .swagger-ui section.models { background: var(--tls-surface) !important; border: 1px solid var(--tls-border) !important; }
    .swagger-ui .scheme-container { background: var(--tls-surface) !important; border-bottom: 1px solid var(--tls-border) !important; }

    /* custom header bar */
    #tls-header {
      background: var(--tls-surface);
      border-bottom: 1px solid var(--tls-border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    #tls-header .logo { color: var(--tls-accent); font-weight: 700; font-size: 14px; letter-spacing: 0.1em; }
    #tls-header .badge { color: var(--tls-muted); font-size: 12px; }
    #tls-header a { color: var(--tls-muted); text-decoration: none; font-size: 12px; margin-left: auto; }
    #tls-header a:hover { color: var(--tls-fg); }
  </style>
</head>
<body>

  <div id="tls-header">
    <span class="logo">[TALOS PROTOCOL]</span>
    <span class="badge">REST API Reference</span>
    <a href="/docs">← Dev Docs</a>
    <a href="/api/docs/openapi.json" style="margin-left: 8px;">OpenAPI JSON</a>
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
      requestInterceptor: (req) => {
        // Strip the topbar URL bar (already hidden via CSS)
        return req;
      },
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
