export const TZ = "America/Bogota";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Fecha ISO (YYYY-MM-DD) de `now` en America/Bogota. */
export function hoyBogota(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function diaSemana(iso: string): string {
  return DIAS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

/** "2026-10-01" → "01 oct" */
export function fechaCorta(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d} ${MESES[Number(m) - 1]}`;
}

// Google Sheets: día 0 = 1899-12-30.
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DIA_MS = 86_400_000;

export function serialToISO(serial: number): string {
  return new Date(EPOCH_MS + Math.floor(serial) * DIA_MS).toISOString().slice(0, 10);
}
