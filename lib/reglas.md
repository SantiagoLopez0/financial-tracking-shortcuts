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
- En una Transferencia con conversión no pongas trm a menos que te diga la TRM de Google de ese día: la tasa aplicada (montoDestino / montoOrigen) ya la calcula la columna L, y trm se usa para medir el costo frente a la TRM.
- Cuenta por defecto si no la digo: COP → "Nu Bank", USD → "DolarApp (ARQ)". Decláralo como supuesto.

## Montos
- Montos coloquiales: "lucas"/"mil" = ×1.000, "palo"/"millón" = ×1.000.000, "1 millón 560" = 1.560.000.
- En una enumeración ("luz 109 mil y agua 60") un número suelto hereda el multiplicador del anterior (agua = 60.000).

## Fechas
- Fechas relativas ("ayer", "el lunes") según zona America/Bogota. Por defecto: hoy.

## Conceptos
- Usa el concepto del catálogo más cercano. Si ninguno encaja, propón uno nuevo y márcalo newConcept=true.

## Pendientes
- Si el texto describe un pago de algo que ya está como Pendiente ("pagué el arriendo"), NO insertes: usa la operación update sobre esa fila (estado = Pagado, y monto/fecha si los di).

## General
- Un mensaje puede producir varias operaciones ("pagué luz 109 mil y agua 60").
- Si falta algo crítico, igual propón tu mejor lectura y lista el supuesto; nunca devuelvas vacío.
