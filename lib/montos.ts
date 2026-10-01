// Lectura determinística de cantidades coloquiales en español colombiano.
// "32 mil" = 32.000, "80 lucas" = 80.000, "un palo" = 1.000.000, "1 millón 560" = 1.560.000.

const MIL = new Set(["mil", "luca", "lucas", "k"]);
const MILLON = new Set(["millón", "millon", "millones", "palo", "palos"]);
const PALABRAS: Record<string, number> = { un: 1, una: 1, uno: 1 };

export interface MontoDetectado {
  texto: string;
  valor: number;
}

/** "1.560.000" → 1560000, "13.5" → 13.5, "13,5" → 13.5, "1,5" → 1.5 */
export function parseNumero(token: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(token)) return null;
  const partes = token.split(/[.,]/);
  if (partes.length === 1) return Number(token);
  const [entero, ...resto] = partes;
  // Separadores de miles: varios separadores o grupos de exactamente 3 dígitos.
  if (resto.every((p) => p.length === 3)) return Number(entero + resto.join(""));
  if (partes.length === 2) return Number(`${entero}.${resto[0]}`);
  return null;
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

export function extraerMontos(texto: string): MontoDetectado[] {
  const tokens = texto.toLowerCase().match(/\d+(?:[.,]\d+)*|[a-záéíóúñ]+/g) ?? [];
  const out: MontoDetectado[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const siguiente = tokens[i + 1];
    let n = parseNumero(tok);
    // "un"/"una" solo cuenta como número si va seguido de un multiplicador ("un palo").
    if (n === null && tok in PALABRAS && siguiente && (MIL.has(siguiente) || MILLON.has(siguiente))) {
      n = PALABRAS[tok];
    }
    if (n === null) {
      i++;
      continue;
    }
    const inicio = i;
    let valor = n;
    if (siguiente && MIL.has(siguiente)) {
      valor = n * 1_000;
      i += 2;
    } else if (siguiente && MILLON.has(siguiente)) {
      valor = n * 1_000_000;
      i += 2;
      // Cola de miles: "1 millón 560" o "1 millón 560 mil" = 1.560.000
      const cola = tokens[i] !== undefined ? parseNumero(tokens[i]) : null;
      if (cola !== null && tokens[i + 1] && MIL.has(tokens[i + 1])) {
        valor += cola * 1_000;
        i += 2;
      } else if (cola !== null && cola < 1_000) {
        valor += cola * 1_000;
        i += 1;
      }
    } else {
      i += 1;
    }
    out.push({ texto: tokens.slice(inicio, i).join(" "), valor: redondear(valor) });
  }
  return out;
}

/** Primer monto del texto, o null. */
export function parseMonto(texto: string): number | null {
  return extraerMontos(texto)[0]?.valor ?? null;
}
