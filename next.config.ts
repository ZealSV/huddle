import type { NextConfig } from "next";

// The dashboard is served by the hub (hub/server.js), which also owns /api/* and the WebSocket.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "no-referrer" },
          { key: "x-frame-options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
