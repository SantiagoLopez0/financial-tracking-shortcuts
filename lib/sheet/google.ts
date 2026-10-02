import type { sheets_v4 } from "googleapis";
import { localizarFormula, type Cell, type Write } from "../rows";
import { tramos, type SheetRepo } from "./repo";

export class GoogleSheetRepo implements SheetRepo {
  private client?: Promise<sheets_v4.Sheets>;
  private separador?: Promise<"," | ";">;
  private sheetIds?: Promise<Map<string, number>>;

  constructor(
    private readonly spreadsheetId: string,
    private readonly email: string,
    private readonly privateKey: string,
  ) {}

  private sheets(): Promise<sheets_v4.Sheets> {
    // Import perezoso: googleapis es pesado y no hace falta en modo mock.
    this.client ??= import("googleapis").then(({ google }) => {
      const auth = new google.auth.JWT({
        email: this.email,
        key: this.privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      return google.sheets({ version: "v4", auth });
    });
    return this.client;
  }

  /** Separador de argumentos de fórmulas según la configuración regional del Sheet (es_CO usa ";"). */
  private separadorFormulas(): Promise<"," | ";"> {
    this.separador ??= (async () => {
      const sheets = await this.sheets();
      const res = await sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "properties.locale",
      });
      const locale = (res.data.properties?.locale ?? "en_US").replace("_", "-");
      let decimalConComa = false;
      try {
        decimalConComa = new Intl.NumberFormat(locale).format(1.5).includes(",");
      } catch {
        // locale desconocido para Intl: se asume coma como separador
      }
      return decimalConComa ? ";" : ",";
    })().catch((err) => {
      this.separador = undefined;
      throw err;
    });
    return this.separador;
  }

  private async batchGet(ranges: string[], valueRenderOption: string): Promise<Cell[][][]> {
    const sheets = await this.sheets();
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges,
      valueRenderOption,
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    return (res.data.valueRanges ?? []).map((vr) => (vr.values ?? []) as Cell[][]);
  }

  getValues(ranges: string[]): Promise<Cell[][][]> {
    return this.batchGet(ranges, "UNFORMATTED_VALUE");
  }

  getFormulas(ranges: string[]): Promise<Cell[][][]> {
    return this.batchGet(ranges, "FORMULA");
  }

  /** sheetId de cada hoja por título (lo pide updateDimensionProperties). */
  private sheetId(sheet: string): Promise<number> {
    this.sheetIds ??= (async () => {
      const sheets = await this.sheets();
      const res = await sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "sheets(properties(sheetId,title))",
      });
      return new Map((res.data.sheets ?? []).map((s) => [s.properties!.title!, s.properties!.sheetId!]));
    })().catch((err) => {
      this.sheetIds = undefined;
      throw err;
    });
    return this.sheetIds.then((ids) => {
      const id = ids.get(sheet);
      if (id === undefined) throw new Error(`No existe la hoja "${sheet}"`);
      return id;
    });
  }

  async getHiddenRows(sheet: string, ultimaFila: number): Promise<number[]> {
    const sheets = await this.sheets();
    const res = await sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [`'${sheet.replace(/'/g, "''")}'!A1:A${ultimaFila}`],
      fields: "sheets(data(startRow,rowMetadata(hiddenByUser)))",
    });
    const data = res.data.sheets?.[0]?.data?.[0];
    const inicio = data?.startRow ?? 0;
    return (data?.rowMetadata ?? []).flatMap((m, i) => (m.hiddenByUser ? [inicio + i + 1] : []));
  }

  async setRowsHidden(sheet: string, rows: number[], hidden: boolean): Promise<void> {
    if (rows.length === 0) return;
    const [sheets, sheetId] = await Promise.all([this.sheets(), this.sheetId(sheet)]);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: tramos(rows).map(([a, b]) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: "ROWS", startIndex: a - 1, endIndex: b },
            properties: { hiddenByUser: hidden },
            fields: "hiddenByUser",
          },
        })),
      },
    });
  }

  async batchUpdate(data: Write[]): Promise<void> {
    if (data.length === 0) return;
    const [sheets, separador] = await Promise.all([this.sheets(), this.separadorFormulas()]);
    const localizado = data.map((d) => ({
      range: d.range,
      values: d.raw
        ? d.values
        : d.values.map((row) =>
            row.map((v) => (typeof v === "string" && v.startsWith("=") ? localizarFormula(v, separador) : v)),
          ),
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: localizado },
    });
  }
}
