import { allowedHosts } from "../astro.config";
import { defineMiddleware } from "astro:middleware";

const allowedOriginHosts = new Set(allowedHosts);
const allowedMethods = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";
const defaultAllowedHeaders = "Authorization, Content-Type";

export function applyCorsHeaders(headers: Headers, request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }

  let originHost: string;

  try {
    originHost = new URL(origin).hostname;
  } catch {
    return;
  }

  if (!allowedOriginHosts.has(originHost)) {
    return;
  }

  const requestedHeaders = request.headers.get("access-control-request-headers");

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", allowedMethods);
  headers.set(
    "Access-Control-Allow-Headers",
    requestedHeaders || defaultAllowedHeaders,
  );
  headers.set("Access-Control-Max-Age", "600");
  headers.append("Vary", "Origin");

  if (requestedHeaders) {
    headers.append("Vary", "Access-Control-Request-Headers");
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.request.method === "OPTIONS") {
    const headers = new Headers();

    console.log(`Handling pre-flight request: ${context.request.url}`);
    applyCorsHeaders(headers, context.request);
    console.log(`Middleware handled pre-flight request: ${context.request.url}`);
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  const response = await next();
  applyCorsHeaders(response.headers, context.request);

  console.log(`CORS Middleware processed request: ${context.request.method} ${context.request.url}`);

  return response;
});
