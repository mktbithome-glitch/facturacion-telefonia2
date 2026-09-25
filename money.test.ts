import assert from "node:assert/strict";
import test from "node:test";
import { calculateLine, calculateVat, eurosToCents } from "../src/money.js";

test("convierte euros a céntimos con redondeo comercial", () => {
  assert.equal(eurosToCents("12.345"), 1235);
  assert.equal(eurosToCents("0.004"), 0);
});

test("calcula exceso, cargos y descuento en céntimos", () => {
  const line = calculateLine({
    monthlyFeeCents: 2000,
    consumedGb: "12.5",
    includedGb: "10",
    excessGbCents: 150,
    usageChargesCents: 25,
    otherChargesCents: 100,
    discountCents: 200
  });
  assert.equal(line.excessGb, "2.500");
  assert.equal(line.excessChargeCents, 375);
  assert.equal(line.amountCents, 2300);
});

test("redondea la cuota de IVA una sola vez", () => {
  assert.equal(calculateVat(1001, "0.21"), 210);
  assert.equal(calculateVat(1003, "0.21"), 211);
});
