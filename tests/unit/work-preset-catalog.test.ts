import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCategory } from "@prisma/client";
import { getStandardWorkPresetCatalog } from "../../src/services/work-preset-catalog";

test("gardening starter catalog supports practical hybrid pricing units", () => {
  const catalog = getStandardWorkPresetCatalog(ServiceCategory.GARDENING);
  const byKey = new Map(catalog.map((preset) => [preset.catalogKey, preset]));

  assert.equal(new Set(catalog.map((preset) => preset.catalogKey)).size, catalog.length);
  assert.equal(byKey.get("lawn_maintenance_visit")?.unitType, "FLAT");
  assert.equal(byKey.get("gardening_crew_labor_hour")?.unitType, "HOUR");
  assert.equal(byKey.get("sod_install")?.unitType, "SQ_FT");
  assert.equal(byKey.get("sprinkler_head_replacement")?.unitType, "EACH");
  assert.match(byKey.get("lawn_maintenance_visit")?.description ?? "", /adjust the price/i);

  for (const preset of catalog) {
    assert.ok(preset.description?.trim(), `${preset.catalogKey} must explain its customer-facing scope`);
    assert.ok(preset.defaultQuantity > 0, `${preset.catalogKey} must have a positive default quantity`);
    assert.ok(preset.unitCost >= 0 && preset.unitPrice >= 0, `${preset.catalogKey} prices must be nonnegative`);
  }
});
