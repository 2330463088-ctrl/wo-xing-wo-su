import type { Plugin } from "vite";

// The restored project expects a Sites-specific Vite helper at build time.
// In this recovered snapshot, the helper was not included, so we provide a
// minimal local shim that keeps the build pipeline working.
export function sites(): Plugin {
  return {
    name: "sites-vite-plugin",
  };
}
