import { defineConfig } from "astro/config";
import type { Plugin } from "vite";

// defuss-rpc's route handler, imported statically so it is loaded while the
// config module runner is still alive (a dynamic import() here runs at
// REQUEST time, when the runner is already closed). Being externalized
// (node_modules), both this and the SSR route resolve to the same
// defuss-rpc/dist/server.mjs instance, so the upload-session map is shared
// between the POST bypass below and the SSE progress endpoint.
import { rpcRoute } from "defuss-rpc/server.js";
import { Readable } from "node:stream";

// importing the defuss-astro integration
import defuss from "defuss-astro";

// importing the node adapter for SSR, preview mode
import node from "@astrojs/node";

// importing TailwindCSS and FrankenUI Vite plugins
import tailwindcss from "@tailwindcss/vite";
import franken from "franken-ui/plugin-vite";

/**
 * Dev-server streaming bypass for the binary upload endpoints.
 *
 * Astro's dev SSR pipeline fully buffers request bodies before the route
 * runs (verified 2026-08: a 700MB upload raised RSS by ~1.4GB and the
 * /rpc/upload route was only invoked after the last byte arrived — so
 * defuss-rpc's upload session + SSE progress could never observe a live
 * transfer, and huge uploads sat in RAM). This connect middleware intercepts
 * the upload endpoints BEFORE Astro and hands the raw Node request stream to
 * defuss-rpc's rpcRoute: the body streams to the temp file, and
 * /rpc/upload/progress/<id> serves live SSE frames.
 *
 * The dynamic import resolves the same defuss-rpc ESM instance the SSR route
 * (src/pages/rpc/[...all].ts, externalized via ssr.external) uses, so the
 * module-level upload-session map is shared between POST and SSE GET.
 * Prod (@astrojs/node standalone) streams request bodies natively and does
 * not need this bypass.
 */
function rpcUploadStreamingPlugin(): Plugin {
  return {
    name: "archivar-rpc-upload-streaming",
    configureServer(server) {
      // Node's http.Server defaults kill any request that takes > 300s total
      // (requestTimeout). Multi-hundred-MB browser uploads over slow uplinks
      // exceed that easily (150MB at ~500KB/s ≈ 300s) and the proxy then
      // reports the reset as 502. No total cap in dev; headers still time out.
      if (server.httpServer) {
        (server.httpServer as any).requestTimeout = 0;
      }
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const isUploadPost = req.method === "POST" && url === "/rpc/upload";
        const isProgressGet = req.method === "GET" && url.startsWith("/rpc/upload/progress/");
        if (!isUploadPost && !isProgressGet) return next();
        (async () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const init: Record<string, unknown> = { method: req.method, headers };
          if (isUploadPost) {
            init.body = Readable.toWeb(req);
            init.duplex = "half"; // required by undici for streaming bodies
          }
          const request = new Request(`http://${req.headers.host ?? "localhost"}${url}`, init);
          const response = await rpcRoute({ request } as any);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body) {
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
          } else {
            res.end();
          }
        })().catch(next);
      });
    },
  };
}

export const allowedHosts = [
  "localhost",
  "127.0.0.1",
  "archivar.local",
  "host.docker.internal",
];

// https://astro.build/config
export default defineConfig({
  server: {
    port: 8801,
    host: "0.0.0.0"
  },

  // Dev toolbar stays on in local dev; the container entrypoint sets
  // ARCHIVAR_DEV_TOOLBAR=0 because the deployment has no use for it.
  devToolbar: {
    enabled: process.env.ARCHIVAR_DEV_TOOLBAR !== "0"
  },

  // The app is a defuss SPA that talks to the server exclusively via JSON-based
  // defuss-rpc calls (Content-Type: application/json) and has its own token/API-key
  // guard (src/rpc.ts). Astro's default CSRF origin check blocks POST requests that
  // look like form submissions — including defuss-rpc's schema bootstrap, which
  // sends a bodyless POST to /rpc/schema with no Content-Type. That breaks login
  // (the client can't build the RPC client without the schema), so we disable the
  // redundant origin check here.
  security: {
    checkOrigin: false,
  },

  // add the defuss integration to Astro
  integrations: [
    defuss({
      include: ["src/**/*.tsx"],
    }),
  ],

  vite: {
    // Treat native .node binaries as assets (prevents Vite from trying to parse them as JS)
    assetsInclude: ["**/*.node"],
    ssr: {
      noExternal: ["astro"],
      external: ["ultimate-express", "defuss-express", "defuss-rpc"],
    },

    server: {
      allowedHosts,
      hmr: {
        clientPort: 443,
      },
    },
    preview: {
      allowedHosts,
    },
    plugins: [
      rpcUploadStreamingPlugin(),
      tailwindcss(),
      franken({
        preflight: false,
        layer: true,
        layerExceptions: ["chart"],
      }),
    ],
  },

  // the node adapter allows for server-side rendering and preview mode
  adapter: node({
    mode: "standalone",
  }),
});
