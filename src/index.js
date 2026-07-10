"use strict";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Temporary verification endpoint for the Worker conversion.
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            success: false,
            message: "Method not allowed.",
          },
          405,
        );
      }

      return jsonResponse({
        success: true,
        service: "intelligent-decisions-web",
        worker: "active",
        supabaseUrlConfigured: Boolean(env.SUPABASE_URL),
      });
    }

    // API routes will be implemented in the beta-access build.
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse(
        {
          success: false,
          message: "API route not found.",
        },
        404,
      );
    }

    // Preserve the existing static website for any request that reaches
    // the Worker outside the selectively routed /api/* paths.
    return env.ASSETS.fetch(request);
  },
};
