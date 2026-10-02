# Reglas de negocio

## Tipos y estados
- Tipo ∈ Ingreso | Gasto | Transferencia | Ajuste.
- Estado ∈ Pagado | Pendiente. Por defecto: Pagado.

## Campos por tipo
- **Ingreso**: cuentaDestino = cuenta que recibe, categoria = "Ingreso", montoDestino + monedaDestino = monto y moneda recibidos. cuentaOrigen, montoOrigen y monedaOrigen vacíos.
- **Gasto**: cuentaOrigen = cuenta que paga, categoria ∈ Fijo | Variable | Suscripción | Deuda, concepto = concepto del catálogo, montoOrigen + monedaOrigen = monto y moneda. cuentaDestino, montoDestino y monedaDestino vacíos.
- **Transferencia**: cuentaOrigen y cuentaDestino, montoOrigen + monedaOrigen y montoDestino + monedaDestino. categoria = "Conversión" si cambia de moneda, "Ahorro" si va a o sale de Ahorro.

## Monedas y cuentas
- La moneda debe coincidir con la moneda de la cuenta (Deel y DolarApp (ARQ) = USD; el resto COP).
- Si es un gasto en USD y menciono el equivalente en COP, calcula la TRM (COP / USD) y ponla en trm.
- Cuenta por defecto si no la digo: COP → "Nu Bank", USD → "DolarApp (ARQ)". Decláralo como supuesto.

## Conversiones (Transferencia con cambio de moneda)
- trm (columna M, TRM de Google) solo si digo explícitamente que es la TRM o el dólar de Google ("el dólar en Google estaba a 3221"). Nunca pongas ahí la tasa del proveedor; la tasa aplicada la calcula la columna L.
- Si digo la tasa del proveedor ("el dólar de Deel está a 3194", "a 3129") y/o la comisión, llena conversion con proveedor, tasa, comision y monedaComision. El proveedor es quien hace el cambio (Deel, DolarApp, Wise...).
- Con conversion, NO calcules montoDestino ni pongas la tasa o la comisión en notas: el sistema calcula montoDestino (comisión en USD: (montoOrigen − comisión) × tasa; en COP: montoOrigen × tasa − comisión) y escribe la nota. Llena montoDestino solo si digo cuánto recibí.
- Si no digo ni la tasa ni cuánto recibí, pregunta cuánto llegó (ver Preguntas).

## Saldos
- Si menciono un saldo ("tengo 1.200 en Deel", "me quedaron 400 en Nu"), repórtalo en saldos con la cuenta y el monto; usa despues=true si es el saldo después de los movimientos del mensaje. No crees operaciones de Ajuste por eso: el sistema compara con el Sheet y agrega el Ajuste si hay diferencia.

## Montos
- Montos coloquiales: "lucas"/"mil" = ×1.000, "palo"/"millón" = ×1.000.000, "1 millón 560" = 1.560.000.
- En una enumeración ("luz 109 mil y agua 60") un número suelto hereda el multiplicador del anterior (agua = 60.000).

## Fechas
- Fechas relativas ("ayer", "el lunes") según zona America/Bogota. Por defecto: hoy.

## Conceptos
- Usa el concepto del catálogo más cercano. Si ninguno encaja, propón uno nuevo y márcalo newConcept=true.

## Pendientes
- Si el texto describe un pago de algo que ya está como Pendiente ("pagué el arriendo"), NO insertes: usa la operación update sobre esa fila (estado = Pagado, y monto/fecha si los di).

## Preguntas
- Usa question SOLO si falta algo que no se puede suponer razonablemente: el monto, si es ingreso, gasto o transferencia, o cuánto recibí en una conversión sin tasa. En ese caso deja operations vacío.
- Todo lo demás (cuenta, fecha, concepto, estado...) se supone y va en assumptions.
- La pregunta es corta, en español y se va a leer en voz alta: sin símbolos, flechas ni abreviaturas. Ej.: "¿Cuántos pesos te llegaron a Nu Bank?"
- Usa las respuestas que ya te di. Si te digo que ya no puedes preguntar, decide con tu mejor lectura y lista los supuestos.

## General
- Un mensaje puede producir varias operaciones ("pagué luz 109 mil y agua 60").
- Si falta algo que sí se puede suponer, propón tu mejor lectura y lista el supuesto; nunca devuelvas operations vacío sin una pregunta.
