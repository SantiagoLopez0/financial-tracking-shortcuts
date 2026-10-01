import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // reglas.md se lee con fs en tiempo de ejecución; hay que incluirlo en el bundle de la función.
  outputFileTracingIncludes: {
    "/api/parse": ["./lib/reglas.md"],
  },
};

export default nextConfig;
