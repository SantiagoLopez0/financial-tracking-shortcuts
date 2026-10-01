import type { Cell, Write } from "../rows";
import { GoogleSheetRepo } from "./google";
import { MockSheetRepo } from "./mock";

export interface SheetRepo {
  /** Valores (UNFORMATTED_VALUE, fechas como número serial), un arreglo por rango A1. */
  getValues(ranges: string[]): Promise<Cell[][][]>;
  /** Contenido crudo (FORMULA), un arreglo por rango A1. */
  getFormulas(ranges: string[]): Promise<Cell[][][]>;
  /** Un solo values.batchUpdate con USER_ENTERED. */
  batchUpdate(data: Write[]): Promise<void>;
}

// En globalThis para que todas las rutas compartan la misma instancia (en dev cada ruta es un bundle aparte).
const g = globalThis as unknown as { __sheetRepo?: SheetRepo };

/** Google Sheets si existe SHEET_ID; si no, un mock en memoria. */
export function getSheetRepo(): SheetRepo {
  if (g.__sheetRepo) return g.__sheetRepo;
  const { SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;
  if (SHEET_ID) {
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      throw new Error("Faltan GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_PRIVATE_KEY");
    }
    g.__sheetRepo = new GoogleSheetRepo(
      SHEET_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    );
  } else {
    g.__sheetRepo = new MockSheetRepo();
  }
  return g.__sheetRepo;
}
