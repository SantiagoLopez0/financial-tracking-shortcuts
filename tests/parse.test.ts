import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { limpiarPregunta, revisar } from "../lib/claude";
import { ParseBodySchema, decodeHistory, encodeHistory, parsear, turnosRespondidos } from "../lib/parse";
import { decodeDraft } from "../lib/schema";
import { datos } from "./fixtures";

const NOW = new Date("2026-10-01T15:00:00Z");

/** Cliente falso: responde en orden con los inputs dados para el tool y guarda los requests. */
function clienteFalso(...inputs: unknown[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(structuredClone(p));
        const input = inputs[requests.length - 1];
        return {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `t${requests.length}`, name: "registrar_movimientos", input }],
        };
      },
    },
  } as unknown as Anthropic;
  const ultimoMensaje = (i: number) => {
    const m = requests[i].messages[0].content;
    return typeof m === "string" ? m : "";
  };
  return { client, requests, ultimoMensaje };
}

/** Body como lo manda el Atajo: pasa por el schema de la ruta (claves vacías incluidas). */
const body = (b: Record<string, unknown>) =>
  ParseBodySchema.parse({ text: "Mandé 300 dólares de Deel a Nu", ...b });

const PREGUNTA = "¿Cuántos pesos te llegaron a Nu Bank?";

const transferencia = {
  action: "insert",
  row: {
    fecha: "2026-10-01", tipo: "Transferencia", cuentaOrigen: "Deel", cuentaDestino: "Nu Bank",
    categoria: "Conversión", concepto: "Deel → Nu Bank", montoOrigen: 300, monedaOrigen: "USD",
    montoDestino: 940_000, monedaDestino: "COP", estado: "Pagado",
  },
};

describe("modo pregunta", () => {
  it("devuelve status question y history opaco (base64url) con la pregunta pendiente", async () => {
    const { client } = clienteFalso({ operations: [], assumptions: [], question: PREGUNTA });
    const res = await parsear(body({}), datos, { client, now: NOW });
    expect(res).toMatchObject({ status: "question", question: PREGUNTA });
    if (res.status !== "question") return;
    expect(res.history).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHistory(res.history)).toEqual([{ q: PREGUNTA, a: "" }]);
  });

  it("status ok trae history vacío para que el Atajo siempre encuentre la clave", async () => {
    const { client } = clienteFalso({ operations: [transferencia], assumptions: [] });
    const res = await parsear(body({}), datos, { client, now: NOW });
    expect(Object.keys(res).sort()).toEqual(["draft", "history", "status", "summary"]);
    expect(res).toMatchObject({ status: "ok", history: "" });
  });

  it("flujo del Atajo: pregunta → se reenvía history + answer → borrador", async () => {
    const { client, ultimoMensaje } = clienteFalso(
      { operations: [], assumptions: [], question: PREGUNTA },
      { operations: [transferencia], assumptions: [] },
    );
    const q = await parsear(body({ history: "", answer: "" }), datos, { client, now: NOW });
    if (q.status !== "question") throw new Error("esperaba una pregunta");
    const res = await parsear(body({ history: q.history, answer: "940 mil" }), datos, { client, now: NOW });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(decodeDraft(res.draft)).toEqual([transferencia]);
    expect(ultimoMensaje(1)).toContain(`P: ${PREGUNTA}\nR: «940 mil»`);
    expect(ultimoMensaje(1)).toContain('"940 mil" = 940000');
    expect(ultimoMensaje(1)).not.toContain("Ya no puedes");
  });

  it("la segunda pregunta acumula el history", async () => {
    const { client } = clienteFalso({ operations: [], assumptions: [], question: "¿Desde qué cuenta?" });
    const history = encodeHistory([{ q: PREGUNTA, a: "" }]);
    const res = await parsear(body({ history, answer: "940 mil" }), datos, { client, now: NOW });
    if (res.status !== "question") throw new Error("esperaba una pregunta");
    expect(decodeHistory(res.history)).toEqual([
      { q: PREGUNTA, a: "940 mil" },
      { q: "¿Desde qué cuenta?", a: "" },
    ]);
  });

  it("en la tercera ronda no se puede preguntar: si insiste, se reintenta y decide", async () => {
    const { client, requests, ultimoMensaje } = clienteFalso(
      { operations: [], assumptions: [], question: "¿Y la fecha?" },
      { operations: [transferencia], assumptions: ["fecha de hoy"] },
    );
    const history = encodeHistory([{ q: "¿Cuánto llegó?", a: "940 mil" }, { q: "¿A qué cuenta?", a: "" }]);
    const res = await parsear(body({ history, answer: "Nu" }), datos, { client, now: NOW });
    expect(ultimoMensaje(0)).toContain("Ya no puedes hacer más preguntas");
    expect(requests).toHaveLength(2);
    const retry = requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(retry[0].content)).toMatch(/ya no puedes preguntar más/);
    expect(res).toMatchObject({ status: "ok", history: "" });
  });

  it("mantiene previousDraft/correction junto con history", async () => {
    const { client, ultimoMensaje } = clienteFalso({ operations: [transferencia], assumptions: [] });
    const previousDraft = Buffer.from(JSON.stringify([transferencia])).toString("base64url");
    const res = await parsear(
      body({ previousDraft, correction: "fue desde Deel", history: "", answer: "" }),
      datos,
      { client, now: NOW },
    );
    expect(res.status).toBe("ok");
    expect(ultimoMensaje(0)).toContain("Corrección: «fue desde Deel»");
  });

  it("en la última ronda, si trae pregunta y operaciones, ignora la pregunta", () => {
    const r = revisar({ operations: [transferencia], assumptions: [], question: "¿Seguro?" }, datos, { puedePreguntar: false, now: NOW });
    expect(r).toMatchObject({ ok: true, value: { tipo: "borrador" } });
  });

  it("operations vacío sin pregunta es un error", () => {
    expect(revisar({ operations: [], assumptions: [] }, datos)).toMatchObject({ ok: false });
  });

  it("la pregunta se limpia para leerla en voz alta", () => {
    expect(limpiarPregunta("¿Cuántos **COP** te llegaron (Deel → Nu)?  ")).toBe("¿Cuántos COP te llegaron (Deel a Nu)?");
    expect(limpiarPregunta("¿Fue $300 USD?")).toBe("¿Fue 300 USD?");
  });

  it("claves vacías o null cuentan como ausentes", () => {
    expect(body({ history: "", answer: "", previousDraft: null, correction: "  " })).toEqual({
      text: "Mandé 300 dólares de Deel a Nu",
    });
  });

  it("history: inválido, answer sin pregunta o pregunta sin responder dan 400", () => {
    const pendiente = encodeHistory([{ q: "¿Cuánto?", a: "" }]);
    expect(() => turnosRespondidos("no-es-history")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => turnosRespondidos(encodeHistory([{ q: "", a: "" }]))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => turnosRespondidos(undefined, "hola")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => turnosRespondidos(pendiente)).toThrow(expect.objectContaining({ status: 400 }));
    expect(turnosRespondidos(pendiente, "10")).toEqual([{ q: "¿Cuánto?", a: "10" }]);
  });
});

describe("revisar: conversión + saldo", () => {
  it("agrega el Ajuste antes de la transferencia y calcula J con la tasa del proveedor", () => {
    const r = revisar(
      {
        operations: [
          {
            action: "insert",
            row: {
              fecha: "2026-10-01", tipo: "Transferencia", cuentaOrigen: "Deel", cuentaDestino: "Nu Bank",
              categoria: "Conversión", concepto: "Deel → Nu Bank", montoOrigen: 800, monedaOrigen: "USD",
              estado: "Pagado", conversion: { proveedor: "Deel", tasa: 3194, comision: 12.6, monedaComision: "USD" },
            },
          },
        ],
        assumptions: [],
        saldos: [{ cuenta: "Deel", saldo: 1200 }],
      },
      datos,
      { now: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.tipo !== "borrador") return;
    const [ajuste, transfer] = r.value.operations;
    expect(ajuste).toMatchObject({ row: { tipo: "Ajuste", cuentaOrigen: "Deel", montoOrigen: 12 } });
    expect(transfer).toMatchObject({ row: { montoDestino: 2_514_956, monedaDestino: "COP" } });
  });
});
