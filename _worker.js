export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle VPN / Proxy Requests directly on Cloudflare Edge!
    if (url.pathname.startsWith("/api/proxy") || url.pathname.startsWith("/api/vpn")) {
      const targetUrl = url.searchParams.get("url");
      const serverId = url.searchParams.get("server") || "us-east";

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      let fullUrl = targetUrl.trim();
      if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
        fullUrl = "https://" + fullUrl;
      }

      const serverProfiles = {
        "us-east": { ip: "198.51.100.42", lang: "en-US,en;q=0.9", name: "US East (Ashburn)" },
        "de-fra": { ip: "142.132.241.88", lang: "de-DE,de;q=0.9,en;q=0.8", name: "Germany (Frankfurt)" },
        "ch-zrh": { ip: "185.220.101.5", lang: "de-CH,de;q=0.9,en;q=0.8", name: "Switzerland (Zurich)" },
        "is-rey": { ip: "193.187.91.22", lang: "is-IS,is;q=0.9,en;q=0.8", name: "Iceland (Reykjavik)" },
        "sg-sin": { ip: "103.253.144.19", lang: "en-SG,en;q=0.9", name: "Singapore" },
        "jp-tyo": { ip: "133.130.54.12", lang: "ja-JP,ja;q=0.9,en;q=0.8", name: "Japan (Tokyo)" },
        "uk-lon": { ip: "185.107.56.20", lang: "en-GB,en;q=0.9", name: "United Kingdom (London)" },
        "ca-mon": { ip: "149.56.128.91", lang: "en-CA,fr-CA;q=0.9,en;q=0.8", name: "Canada (Montreal)" },
      };
      const profile = serverProfiles[serverId] || serverProfiles["us-east"];

      try {
        const resp = await fetch(fullUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": profile.lang,
            "X-Forwarded-For": profile.ip,
            "X-Real-IP": profile.ip,
          },
          redirect: "follow",
        });

        const contentType = resp.headers.get("content-type") || "text/html";
        const newHeaders = new Headers(resp.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST");
        newHeaders.delete("Content-Security-Policy");
        newHeaders.delete("X-Frame-Options");
        newHeaders.delete("Frame-Options");
        newHeaders.set("X-VPN-Node", profile.name);
        newHeaders.set("X-VPN-Virtual-IP", profile.ip);

        if (contentType.includes("text/html")) {
          let html = await resp.text();
          html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
          html = html.replace(/<meta[^>]*http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, "");
          html = html.replace(/if\s*\(top\s*!==\s*self\)[^}]+}/gi, "");

          const injection = `
<base href="${fullUrl}">
<script>
  window.__VPN_SERVER__ = "${serverId}";
  window.__VPN_VIRTUAL_IP__ = "${profile.ip}";
  window.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href");
      if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
        try {
          const abs = new URL(href, "${fullUrl}").href;
          a.setAttribute("href", "/api/proxy?url=" + encodeURIComponent(abs) + "&server=" + window.__VPN_SERVER__);
        } catch(e){}
      }
    });
  });
</script>
`;
          if (html.includes("<head>")) {
            html = html.replace("<head>", "<head>" + injection);
          } else {
            html = injection + html;
          }
          return new Response(html, {
            status: resp.status,
            headers: newHeaders,
          });
        }

        return new Response(resp.body, {
          status: resp.status,
          headers: newHeaders,
        });
      } catch (err) {
        return new Response(
          `<div style="background:#090d16;color:#fff;font-family:sans-serif;padding:36px;border-radius:12px;text-align:center;max-width:500px;margin:40px auto;border:1px solid #1e293b;">
            <h2 style="color:#22d3ee;margin:0 0 8px;">🛡️ 1117 VPN Gateway</h2>
            <p style="color:#94a3b8;font-size:14px;">Connection through ${profile.name} timed out or destination refused.</p>
            <p style="color:#ef4444;font-size:12px;font-family:monospace;margin:12px 0;">${err.message || "Failed to reach host"}</p>
          </div>`,
          {
            status: 502,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // 2. Serve static asset from the Cloudflare asset store
    try {
      if (env.ASSETS) {
        const response = await env.ASSETS.fetch(request);
        if (response.status !== 404) {
          return response;
        }

        // 3. Normalize nested assets
        if (url.pathname.includes("/assets/")) {
          const cleanAssetPath = "/assets/" + url.pathname.split("/assets/").pop();
          const cleanRequest = new Request(new URL(cleanAssetPath, request.url), request);
          const assetResponse = await env.ASSETS.fetch(cleanRequest);
          if (assetResponse.status !== 404) {
            return assetResponse;
          }
        }

        // 4. Single-Page Application (SPA) Fallback: Serve /index.html for all page routes
        const indexRequest = new Request(new URL("/index.html", request.url), request);
        return await env.ASSETS.fetch(indexRequest);
      }
    } catch (_err) {
      if (env.ASSETS) {
        try {
          return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
        } catch (_e) {}
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
