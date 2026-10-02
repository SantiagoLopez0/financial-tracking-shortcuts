import path from "node:path";
import type { NextConfig } from "next";

// Raíz del proyecto: evita que Next tome un package-lock.json de una carpeta superior como raíz.
const root = path.join(__dirname);

const nextConfig: NextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
  // reglas.md se lee con fs en tiempo de ejecución; hay que incluirlo en el bundle de la función.
  outputFileTracingIncludes: {
    "/api/parse": ["./lib/reglas.md"],
  },
};

export default nextConfig;
