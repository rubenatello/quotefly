import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCategory } from "@prisma/client";
import {
  getStandardWorkPresetCatalog,
  standardWorkPresetContentHash,
} from "../../src/services/work-preset-catalog";

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

test("every trade publishes versioned starter definitions with stable unique keys", () => {
  for (const serviceType of Object.values(ServiceCategory)) {
    const catalog = getStandardWorkPresetCatalog(serviceType);
    assert.ok(catalog.length >= 10, `${serviceType} should have a practical starter catalog`);
    assert.equal(new Set(catalog.map((preset) => preset.catalogKey)).size, catalog.length);

    for (const preset of catalog) {
      assert.ok(Number.isInteger(preset.catalogVersion) && preset.catalogVersion > 0);
      assert.match(standardWorkPresetContentHash(serviceType, preset), /^[a-f0-9]{64}$/);
      assert.ok(preset.name.trim());
      assert.ok(preset.name.length <= 120);
      assert.ok(preset.description?.trim());
      assert.ok((preset.description?.length ?? 0) <= 500);
      assert.ok(preset.defaultQuantity > 0);
      assert.ok(preset.unitCost >= 0);
      assert.ok(preset.unitPrice >= 0);
      assert.ok(preset.unitPrice >= preset.unitCost, `${serviceType}.${preset.catalogKey} should not start below cost`);
    }
  }
});

test("construction starter catalog covers core labor, project work, and fees", () => {
  const catalog = getStandardWorkPresetCatalog(ServiceCategory.CONSTRUCTION);
  const byKey = new Map(catalog.map((preset) => [preset.catalogKey, preset]));

  assert.equal(byKey.get("general_labor")?.unitType, "HOUR");
  assert.equal(byKey.get("drywall_install_finish")?.unitType, "SQ_FT");
  assert.equal(byKey.get("concrete_slab_install")?.unitType, "SQ_FT");
  assert.equal(byKey.get("permit_allowance")?.category, "FEE");
  assert.equal(byKey.get("final_cleanup")?.category, "SERVICE");
});
