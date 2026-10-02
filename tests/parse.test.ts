import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { limpiarPregunta, revisar } from "../lib/claude";
import { parsear, turnosRespondidos, type ParseBody } from "../lib/parse";
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

const body = (b: Partial<ParseBody>): ParseBody => ({ text: "Mandé 300 dólares de Deel a Nu", history: [], ...b });

const transferencia = {
  action: "insert",
  row: {
    fecha: "2026-10-01", tipo: "Transferencia", cuentaOrigen: "Deel", cuentaDestino: "Nu Bank",
    categoria: "Conversión", concepto: "Deel → Nu Bank", montoOrigen: 300, monedaOrigen: "USD",
    montoDestino: 940_000, monedaDestino: "COP", estado: "Pagado",
  },
};

describe("modo pregunta", () => {
  it("devuelve status question y el history con la pregunta pendiente", async () => {
    const { client } = clienteFalso({ operations: [], assumptions: [], question: "¿Cuántos pesos te llegaron a Nu Bank?" });
    expect(await parsear(body({}), datos, { client, now: NOW })).toEqual({
      status: "question",
      question: "¿Cuántos pesos te llegaron a Nu Bank?",
      history: [{ q: "¿Cuántos pesos te llegaron a Nu Bank?", a: "" }],
    });
  });

  it("ronda pregunta → respuesta → borrador: answer completa el history y va en el mensaje", async () => {
    const { client, ultimoMensaje } = clienteFalso({ operations: [transferencia], assumptions: [] });
    const res = await parsear(
      body({ history: [{ q: "¿Cuántos pesos te llegaron a Nu Bank?", a: "" }], answer: "940 mil" }),
      datos,
      { client, now: NOW },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(decodeDraft(res.draft)).toEqual([transferencia]);
    expect(ultimoMensaje(0)).toContain("P: ¿Cuántos pesos te llegaron a Nu Bank?\nR: «940 mil»");
    expect(ultimoMensaje(0)).toContain('"940 mil" = 940000');
    expect(ultimoMensaje(0)).not.toContain("Ya no puedes");
  });

  it("en la tercera ronda no se puede preguntar: si insiste, se reintenta y decide", async () => {
    const { client, requests, ultimoMensaje } = clienteFalso(
      { operations: [], assumptions: [], question: "¿Y la fecha?" },
      { operations: [transferencia], assumptions: ["fecha de hoy"] },
    );
    const res = await parsear(
      body({ history: [{ q: "¿Cuánto llegó?", a: "940 mil" }, { q: "¿A qué cuenta?", a: "Nu" }] }),
      datos,
      { client, now: NOW },
    );
    expect(ultimoMensaje(0)).toContain("Ya no puedes hacer más preguntas");
    expect(requests).toHaveLength(2);
    const retry = requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(retry[0].content)).toMatch(/ya no puedes preguntar más/);
    expect(res).toMatchObject({ status: "ok" });
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

  it("history: answer sin pregunta pendiente o una pregunta sin responder dan 400", () => {
    expect(() => turnosRespondidos([], "hola")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => turnosRespondidos([{ q: "¿Cuánto?", a: "" }])).toThrow(expect.objectContaining({ status: 400 }));
    expect(turnosRespondidos([{ q: "¿Cuánto?", a: "" }], "10")).toEqual([{ q: "¿Cuánto?", a: "10" }]);
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
