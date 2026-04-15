import { PresetCategory, PresetUnitType, ServiceCategory } from "@prisma/client";

export interface StandardWorkPresetDefinition {
  catalogKey: string;
  name: string;
  description?: string;
  category: PresetCategory;
  unitType: PresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
  isDefault?: boolean;
  matchKeywords?: string[];
  isPrimaryJob?: boolean;
  quantityMode?: "default" | "project_area";
}

export const STANDARD_SQ_FT_BASE_CATALOG_KEY = "sq_ft_base";

const MATCHING_ALIASES: Array<[RegExp, string]> = [
  [/\bqoute\b/g, "quote"],
  [/\bestimte\b/g, "estimate"],
  [/\breplce\b/g, "replace"],
  [/\binstal\b/g, "install"],
  [/\binstll\b/g, "install"],
  [/\barchitechtural\b/g, "architectural"],
  [/\bfurnce\b/g, "furnace"],
  [/\bevap(?:orator)?\s*coil\b/g, "evaporator coil"],
  [/\brefridgerant\b/g, "refrigerant"],
  [/\bcondenesr\b/g, "condenser"],
  [/\bthremostat\b/g, "thermostat"],
  [/\blamnate\b/g, "laminate"],
  [/\bhardwoord\b/g, "hardwood"],
  [/\blinolium\b/g, "linoleum"],
  [/\birragation\b/g, "irrigation"],
  [/\baerateing\b/g, "aerating"],
  [/\bplubming\b/g, "plumbing"],
  [/\bsewr\b/g, "sewer"],
  [/\bhyrdo\b/g, "hydro"],
  [/\btankles\b/g, "tankless"],
  [/\btoiet\b/g, "toilet"],
  [/\bgarburator\b/g, "garbage disposal"],
  [/\bprv\b/g, "pressure regulator valve"],
  [/\bdrane\b/g, "drain"],
  [/\btriming\b/g, "trimming"],
  [/\bchimmney\b/g, "chimney"],
  [/\brepiar\b/g, "repair"],
  [/\baspahlt\b/g, "asphalt"],
  [/\bshngle\b/g, "shingle"],
  [/\bshingels\b/g, "shingles"],
  [/\bspanish\s+tyle\b/g, "spanish tile"],
  [/\bconcret\s+tile\b/g, "concrete tile"],
  [/\bmodbit\b/g, "modified bitumen"],
  [/\btorchdown\b/g, "torch down"],
  [/\bcontorl\b/g, "control"],
  [/\btreatmnt\b/g, "treatment"],
  [/\bclean\s+up\b/g, "cleanup"],
];

function standardPreset(
  catalogKey: string,
  name: string,
  category: PresetCategory,
  unitType: PresetUnitType,
  unitCost: number,
  unitPrice: number,
  description?: string,
  defaultQuantity = 1,
  matchKeywords?: string[],
  options?: {
    isPrimaryJob?: boolean;
    quantityMode?: "default" | "project_area";
  },
): StandardWorkPresetDefinition {
  return {
    catalogKey,
    name,
    category,
    unitType,
    unitCost,
    unitPrice,
    description,
    defaultQuantity,
    isDefault: true,
    matchKeywords,
    isPrimaryJob: options?.isPrimaryJob ?? category === "SERVICE",
    quantityMode: options?.quantityMode ?? (unitType === "SQ_FT" ? "project_area" : "default"),
  };
}

const STANDARD_WORK_PRESET_CATALOG: Record<ServiceCategory, StandardWorkPresetDefinition[]> = {
  PLUMBING: [
    standardPreset("minor_clog", "Minor Clog", "SERVICE", "FLAT", 45, 120, "Drain unclogging / minor blockage resolution.", 1, ["clog", "drain", "blockage", "unclog", "snaking", "drain snake", "auger"], { isPrimaryJob: true }),
    standardPreset("pipe_replacement", "Pipe Replacement", "SERVICE", "FLAT", 180, 450, "Standard replacement section with fittings.", 1, ["pipe replacement", "replace pipe", "repipe", "new pipe"], { isPrimaryJob: true }),
    standardPreset("pipe_burst_repair", "Pipe Burst Repair", "SERVICE", "FLAT", 260, 700, "Emergency burst repair including access and sealing.", 1, ["burst pipe", "pipe burst", "leak", "broken pipe"], { isPrimaryJob: true }),
    standardPreset("slab_leak_detection_repair", "Slab Leak Detection + Repair", "SERVICE", "FLAT", 520, 1450, "Locate and repair slab leak with targeted access and pressure test.", 1, ["slab leak", "slab leak repair", "pressure test", "leak detection"], { isPrimaryJob: true }),
    standardPreset("pex_repipe_partial", "PEX Repipe (Partial)", "SERVICE", "FLAT", 1200, 2950, "Partial hot/cold water repipe using approved piping and fittings.", 1, ["pex repipe", "partial repipe", "repiping", "water line repipe", "copper to pex"], { isPrimaryJob: true }),
    standardPreset("water_heater_replacement", "Water Heater Replacement", "SERVICE", "FLAT", 1050, 2450, "Remove and replace standard tank water heater with reconnect and startup.", 1, ["water heater", "heater replacement", "tank water heater", "hot water heater"], { isPrimaryJob: true }),
    standardPreset("tankless_water_heater_upgrade", "Tankless Water Heater Upgrade", "SERVICE", "FLAT", 1750, 3950, "Upgrade to tankless unit with venting and connection updates.", 1, ["tankless", "tankless heater", "tankless water heater"], { isPrimaryJob: true }),
    standardPreset("sewer_camera_inspection", "Sewer Camera Inspection", "SERVICE", "FLAT", 120, 285, "Camera line inspection and blockage diagnosis.", 1, ["camera inspection", "sewer camera", "line inspection"], { isPrimaryJob: false }),
    standardPreset("hydro_jetting", "Hydro-Jetting Drain Service", "SERVICE", "FLAT", 220, 560, "Hydro-jet cleaning for heavy drain/sewer buildup.", 1, ["hydro jet", "hydro-jet", "hydrojetting", "jetting", "sewer cleaning"], { isPrimaryJob: true }),
    standardPreset("sewer_line_repair_trenchless", "Sewer Line Repair/Replacement (Trenchless)", "SERVICE", "FLAT", 1800, 4200, "Trenchless sewer line repair/replacement with restoration allowance.", 1, ["sewer line repair", "sewer replacement", "trenchless", "pipe bursting", "cipp"], { isPrimaryJob: true }),
    standardPreset("fixture_install_package", "Fixture Install Package", "SERVICE", "EACH", 70, 180, "Install faucet, sink, toilet, or similar plumbing fixture.", 1, ["fixture install", "toilet install", "faucet install", "sink install"], { isPrimaryJob: false }),
    standardPreset("toilet_reset_flange_wax_repair", "Toilet Reset + Flange/Wax Repair", "SERVICE", "EACH", 85, 240, "Reset toilet and replace wax ring/flange hardware as needed.", 1, ["toilet reset", "wax ring", "toilet flange", "toilet leak"], { isPrimaryJob: false }),
    standardPreset("garbage_disposal_install_replace", "Garbage Disposal Install/Replace", "SERVICE", "EACH", 95, 260, "Install or replace garbage disposal with drain and electrical reconnect.", 1, ["garbage disposal", "disposal install", "disposer"], { isPrimaryJob: false }),
    standardPreset("pressure_regulator_valve_replacement", "Pressure Regulator Valve (PRV) Replacement", "SERVICE", "EACH", 180, 460, "Replace pressure reducing/regulator valve and verify downstream pressure.", 1, ["pressure regulator valve", "pressure reducing valve", "prv", "water pressure regulator"], { isPrimaryJob: false }),
    standardPreset("backflow_preventer_service", "Backflow Preventer Service", "SERVICE", "FLAT", 140, 390, "Backflow preventer test/repair coordination for code compliance.", 1, ["backflow preventer", "backflow test", "rpz", "double check valve"], { isPrimaryJob: false }),
    standardPreset("sump_pump_install_replace", "Sump Pump Install/Replace", "SERVICE", "FLAT", 420, 1180, "Install or replace sump pump with discharge verification.", 1, ["sump pump", "ejector pump", "basement pump"], { isPrimaryJob: false }),
    standardPreset("shutoff_valve_replacement", "Shutoff Valve Replacement", "SERVICE", "EACH", 40, 125, "Replace worn or leaking shutoff valve.", 1, ["shutoff valve", "angle stop", "valve replacement"], { isPrimaryJob: false }),
    standardPreset("priority_work_fee", "Priority Work Fee", "FEE", "FLAT", 0, 75, "After-hours or urgent response fee.", 1, ["priority", "urgent", "after hours", "emergency"], { isPrimaryJob: false }),
    standardPreset("labor_hour", "Labor Hour", "LABOR", "HOUR", 55, 110, "Hourly plumbing labor.", 1, ["labor hour", "hourly labor"], { isPrimaryJob: false }),
  ],
  ROOFING: [
    standardPreset("asphalt_shingle_remove_replace", "Asphalt Shingle Roof Tear-Off and Replacement", "SERVICE", "SQ_FT", 3.8, 7.9, "Remove existing asphalt shingles, dispose of debris, inspect roof deck, install synthetic underlayment, then install new shingles and accessories.", 100, ["asphalt shingle", "asphalt shingles", "3 tab shingle", "3-tab shingle", "three tab shingle", "composition shingle", "comp shingle", "roof replacement", "replace roof", "reroof", "re-roof", "roofing square", "roof square", "squares"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("architectural_shingle_remove_replace", "Architectural Shingle Roof Tear-Off and Replacement", "SERVICE", "SQ_FT", 4.4, 9.4, "Tear-off and replacement using architectural/laminate shingles, underlayment, starter strip, and ridge cap components.", 100, ["architectural shingle", "architectural shingles", "laminate shingle", "dimensional shingle", "premium shingle", "gaf hdz", "owens corning duration"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("spanish_tile_roof_remove_replace", "Spanish/Clay Tile Roof Replacement", "SERVICE", "SQ_FT", 7.8, 16.8, "Remove and replace Spanish, clay, or concrete tile roofing with compatible underlayment, battens, and flashing details.", 100, ["spanish tile", "clay tile", "concrete tile", "barrel tile", "s-tile", "s tile", "mission tile", "tile roof", "tile reset", "tile relay"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("metal_roof_panel_remove_replace", "Metal Roof Panel Replacement", "SERVICE", "SQ_FT", 6.2, 13.4, "Remove and replace standing seam or corrugated metal roof panels with trim and flashing.", 100, ["metal roof", "standing seam", "corrugated metal", "steel roof", "metal panel", "exposed fastener", "r panel", "r-panel"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("tpo_membrane_roof_replace", "TPO Flat Roof Membrane Replacement", "SERVICE", "SQ_FT", 4.9, 10.8, "Tear-off and install TPO single-ply membrane system on low-slope/flat roof sections.", 100, ["tpo", "single ply", "single-ply", "flat roof membrane", "tpo membrane", "60 mil tpo", "80 mil tpo"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("epdm_membrane_roof_replace", "EPDM Flat Roof Membrane Replacement", "SERVICE", "SQ_FT", 4.7, 10.2, "Install EPDM membrane roofing on low-slope areas with seam prep and flashing tie-ins.", 100, ["epdm", "rubber roof", "flat roof epdm", "low slope roof", "low-slope roof"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("modified_bitumen_torch_down_replace", "Modified Bitumen / Torch-Down Roof Replacement", "SERVICE", "SQ_FT", 4.2, 9.6, "Install modified bitumen torch-down membrane roofing system for low-slope sections.", 100, ["modified bitumen", "mod bit", "torch down", "torch-down", "cap sheet", "granulated cap sheet", "flat roof"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("underlayment_layer", "Underlayment Layer", "MATERIAL", "SQ_FT", 0.35, 0.85, "Synthetic underlayment.", 100, ["underlayment"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("ice_water_shield_upgrade", "Ice and Water Shield Upgrade", "MATERIAL", "SQ_FT", 0.45, 1.1, "Self-adhered membrane at vulnerable roof areas.", 100, ["ice and water shield", "ice water shield", "self adhered membrane", "self-adhered membrane"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("roof_deck_repair_allowance", "Roof Deck Repair Allowance", "SERVICE", "SQ_FT", 1.2, 2.8, "Deck repair when damage is discovered.", 25, ["deck repair", "roof deck", "rot", "wood rot", "damaged deck"], { isPrimaryJob: false, quantityMode: "default" }),
    standardPreset("flashing_package", "Flashing Package", "MATERIAL", "FLAT", 80, 185, "Valley and edge flashing package.", 1, ["flashing", "valley", "edge metal"], { isPrimaryJob: false }),
    standardPreset("roof_leak_diagnostic", "Roof Leak Diagnostic", "SERVICE", "FLAT", 90, 245, "Leak source inspection with moisture path check.", 1, ["roof leak", "leak diagnostic", "water intrusion"], { isPrimaryJob: true }),
    standardPreset("ridge_vent_install", "Ridge Vent Install", "SERVICE", "EACH", 85, 220, "Install or replace ridge vent sections.", 1, ["ridge vent", "roof ventilation", "attic ventilation"], { isPrimaryJob: false }),
    standardPreset("chimney_flashing_repair", "Chimney Flashing Repair", "SERVICE", "FLAT", 140, 360, "Repair or replace chimney flashing and seal transitions.", 1, ["chimney flashing", "chimney leak", "counter flashing"], { isPrimaryJob: false }),
    standardPreset("roof_coating_system", "Roof Coating System", "SERVICE", "SQ_FT", 1.9, 4.6, "Clean, prep, and apply elastomeric roof coating.", 100, ["roof coating", "elastomeric", "flat roof coating"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("gutter_replacement_labor", "Gutter Replacement Labor", "LABOR", "HOUR", 80, 165, "Labor for gutter and downspout replacement work.", 4, ["gutter replacement", "downspout", "gutter labor"], { isPrimaryJob: false }),
    standardPreset("permit_inspection_fee", "Permit + Inspection Fee", "FEE", "FLAT", 0, 185, "Permit filing and required inspection coordination.", 1, ["permit", "inspection fee", "city permit"], { isPrimaryJob: false }),
    standardPreset("disposal_fee", "Disposal Fee", "FEE", "FLAT", 90, 220, "Dump/disposal and haul-away.", 1, ["disposal", "dispose", "haul away", "haul-away", "dump"], { isPrimaryJob: false }),
  ],
  FLOORING: [
    standardPreset("floor_demo_disposal", "Floor Demo + Disposal", "SERVICE", "SQ_FT", 1.1, 2.5, "Removal and disposal of old flooring.", 100, ["demo", "demolition", "remove flooring", "floor removal"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("lvp_install", "LVP Install", "SERVICE", "SQ_FT", 2.6, 5.9, "Install luxury vinyl plank.", 100, ["lvp", "vinyl plank", "luxury vinyl plank"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("linoleum_sheet_install", "Linoleum / Vinyl Sheet Install", "SERVICE", "SQ_FT", 2.1, 4.9, "Install linoleum or sheet vinyl with adhesive and seam finishing.", 100, ["linoleum", "sheet vinyl", "vinyl sheet", "marmoleum", "lvt", "glue down", "glue-down"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("tile_install", "Tile Install", "SERVICE", "SQ_FT", 4.5, 9.5, "Tile setting and grout finish.", 100, ["tile", "grout"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("laminate_install", "Laminate Install", "SERVICE", "SQ_FT", 2.35, 5.4, "Install laminate flooring with cuts and transitions.", 100, ["laminate", "laminate flooring", "floating floor", "click lock", "click-lock"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("hardwood_install", "Hardwood Install", "SERVICE", "SQ_FT", 4.95, 10.9, "Install engineered or solid hardwood flooring.", 100, ["hardwood", "engineered wood", "wood floor", "nail down", "nail-down", "glue down", "glue-down", "floating wood"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("hardwood_refinish", "Hardwood Sand + Refinish", "SERVICE", "SQ_FT", 1.9, 4.8, "Sand, stain (if needed), and refinish existing hardwood floor.", 100, ["hardwood refinish", "sand and finish", "wood floor refinish"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("carpet_install", "Carpet Install", "SERVICE", "SQ_FT", 2.2, 5.2, "Install carpet and pad with seam finishing.", 100, ["carpet", "carpet install", "padding", "carpet cushion", "carpet pad"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("carpet_cushion_pad_install", "Carpet Cushion/Pad Install", "MATERIAL", "SQ_FT", 0.45, 1.35, "Install carpet cushion/padding under broadloom carpet.", 100, ["carpet cushion", "carpet pad", "pad install", "padding"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("underlayment", "Underlayment", "MATERIAL", "SQ_FT", 0.42, 0.95, "Subfloor prep underlayment.", 100, ["underlayment"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("moisture_barrier", "Moisture Barrier", "MATERIAL", "SQ_FT", 0.28, 0.78, "Moisture/vapor barrier material under finish floor.", 100, ["moisture barrier", "vapor barrier", "moisture membrane"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("tile_backer_or_uncoupling_membrane", "Tile Backer / Uncoupling Membrane", "MATERIAL", "SQ_FT", 0.85, 2.1, "Install cement backer board or uncoupling membrane before tile setting.", 100, ["backer board", "cement board", "hardiebacker", "ditra", "uncoupling membrane", "uncoupling", "waterproofing membrane", "thinset"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("subfloor_leveling", "Subfloor Leveling", "SERVICE", "SQ_FT", 0.95, 2.4, "Patch and level subfloor before install.", 100, ["subfloor leveling", "self leveler", "floor prep", "subfloor prep"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("moisture_mitigation_primer", "Moisture Mitigation Primer", "MATERIAL", "SQ_FT", 0.5, 1.35, "Primer/sealer for elevated slab moisture conditions.", 100, ["moisture mitigation", "slab moisture", "primer", "sealer"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("trim_transition_kit", "Trim/Transition Kit", "MATERIAL", "EACH", 18, 45, "Transition strips and trim.", 1, ["transition", "trim"], { isPrimaryJob: false }),
    standardPreset("baseboard_reinstall", "Baseboard Reinstall", "SERVICE", "EACH", 16, 42, "Remove and reinstall/replace baseboard sections.", 1, ["baseboard", "quarter round", "shoe molding"], { isPrimaryJob: false }),
  ],
  HVAC: [
    standardPreset("system_tune_up", "System Tune-Up", "SERVICE", "FLAT", 65, 145, "Routine maintenance and performance check.", 1, ["tune up", "tune-up", "maintenance", "service"], { isPrimaryJob: true }),
    standardPreset("ac_condenser_replacement", "AC Condenser Replacement", "SERVICE", "FLAT", 1400, 3300, "Remove and replace condenser unit.", 1, ["condenser", "ac replacement", "replace ac", "air conditioner", "ac unit", "seer2", "high efficiency"], { isPrimaryJob: true }),
    standardPreset("furnace_install", "Furnace Install", "SERVICE", "FLAT", 1800, 4200, "Install/replace furnace unit.", 1, ["furnace", "heater", "heating system"], { isPrimaryJob: true }),
    standardPreset("ductwork_repair", "Ductwork Repair", "SERVICE", "HOUR", 70, 145, "Duct repair labor hour.", 1, ["duct", "ductwork", "vents"], { isPrimaryJob: true }),
    standardPreset("heat_pump_replacement", "Heat Pump Replacement", "SERVICE", "FLAT", 2100, 4950, "Replace heat pump system and test operation.", 1, ["heat pump", "heat pump replacement", "hspf2", "seer2", "cold climate heat pump"], { isPrimaryJob: true }),
    standardPreset("mini_split_install_zone", "Mini-Split Install (Per Zone)", "SERVICE", "EACH", 950, 2250, "Install single mini-split indoor zone with line set.", 1, ["mini split", "mini-split", "ductless", "multi zone", "multi-zone", "head unit"], { isPrimaryJob: true }),
    standardPreset("air_handler_replacement", "Air Handler Replacement", "SERVICE", "FLAT", 1200, 2950, "Replace indoor air handler and reconnect controls.", 1, ["air handler", "blower unit", "indoor unit"], { isPrimaryJob: true }),
    standardPreset("evaporator_coil_replacement", "Evaporator Coil Replacement", "SERVICE", "FLAT", 750, 1950, "Replace indoor evaporator coil and verify refrigerant charge.", 1, ["evaporator coil", "evap coil", "a coil", "a-coil", "indoor coil"], { isPrimaryJob: true }),
    standardPreset("compressor_replacement", "Compressor Replacement", "SERVICE", "FLAT", 1200, 3200, "Replace failed compressor and recommission condenser circuit.", 1, ["compressor replacement", "ac compressor", "compressor"], { isPrimaryJob: true }),
    standardPreset("refrigerant_leak_repair", "Refrigerant Leak Repair", "SERVICE", "FLAT", 260, 690, "Locate, seal, and recharge for verified leak repair.", 1, ["refrigerant leak", "freon leak", "leak repair", "recharge"], { isPrimaryJob: false }),
    standardPreset("refrigerant_recharge_service", "Refrigerant Recharge Service", "SERVICE", "FLAT", 190, 520, "Recover/charge refrigerant and verify operating pressures.", 1, ["refrigerant recharge", "recharge", "r410a", "r-410a", "r32", "r-32", "recovery", "reclaim"], { isPrimaryJob: false }),
    standardPreset("capacitor_contactor_replacement", "Capacitor + Contactor Replacement", "SERVICE", "FLAT", 95, 285, "Replace failed electrical start/run components in condenser.", 1, ["capacitor", "contactor", "start capacitor", "run capacitor"], { isPrimaryJob: false }),
    standardPreset("thermostat_install", "Thermostat Install", "SERVICE", "EACH", 65, 185, "Install and configure programmable/smart thermostat.", 1, ["thermostat", "smart thermostat"], { isPrimaryJob: false }),
    standardPreset("duct_sealing_package", "Duct Sealing Package", "SERVICE", "FLAT", 220, 540, "Seal major duct leaks and verify airflow.", 1, ["duct sealing", "air leak", "airflow balancing"], { isPrimaryJob: false }),
    standardPreset("airflow_static_pressure_diagnostic", "Airflow + Static Pressure Diagnostic", "SERVICE", "FLAT", 120, 320, "Test static pressure and airflow distribution across the system.", 1, ["static pressure", "airflow diagnostic", "cfm test", "air balance", "manual j", "manual d"], { isPrimaryJob: false }),
    standardPreset("priority_dispatch_fee", "Priority Dispatch Fee", "FEE", "FLAT", 0, 95, "After-hours dispatch fee.", 1, ["priority", "urgent", "after hours", "emergency"], { isPrimaryJob: false }),
  ],
  GARDENING: [
    standardPreset("lawn_maintenance_visit", "Lawn Maintenance Visit", "SERVICE", "FLAT", 30, 75, "Mow, edge, cleanup.", 1, ["lawn maintenance", "mow", "mowing", "yard maintenance"], { isPrimaryJob: true }),
    standardPreset("sod_install", "Sod Install", "SERVICE", "SQ_FT", 0.8, 2.1, "Supply and install new sod.", 200, ["sod", "resod", "new lawn"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("lawn_aeration_overseed", "Lawn Aeration + Overseed", "SERVICE", "SQ_FT", 0.28, 0.85, "Core aeration and overseeding for turf recovery.", 1000, ["aeration", "aerate", "core aeration", "overseed", "lawn recovery"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("fertilization_treatment_visit", "Fertilization Treatment Visit", "SERVICE", "FLAT", 45, 120, "Fertilizer and nutrient treatment application.", 1, ["fertilization", "fertilizer", "weed and feed", "lawn treatment"], { isPrimaryJob: false }),
    standardPreset("pre_emergent_weed_barrier", "Pre-Emergent Weed Barrier", "SERVICE", "FLAT", 55, 145, "Apply pre-emergent treatment to reduce weed germination.", 1, ["pre emergent", "pre-emergent", "preemergence", "weed prevention"], { isPrimaryJob: false }),
    standardPreset("mulch_install", "Mulch Install", "MATERIAL", "SQ_FT", 0.35, 1, "Mulch supply and install.", 100, ["mulch"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("planting_bed_refresh", "Planting Bed Refresh", "SERVICE", "FLAT", 95, 245, "Refresh planting beds, edge, and amend soil.", 1, ["planting bed", "bed refresh", "soil amendment"], { isPrimaryJob: true }),
    standardPreset("hedge_trimming", "Hedge Trimming", "SERVICE", "HOUR", 40, 95, "Trim and shape hedges/shrubs.", 2, ["hedge trim", "shrub trimming", "trim hedges"], { isPrimaryJob: true }),
    standardPreset("tree_trimming_service", "Tree Trimming Service", "SERVICE", "HOUR", 65, 155, "Tree trimming and canopy cleanup labor.", 2, ["tree trimming", "pruning", "canopy"], { isPrimaryJob: true }),
    standardPreset("irrigation_repair", "Irrigation Repair", "SERVICE", "HOUR", 45, 105, "Sprinkler and irrigation labor hour.", 1, ["irrigation", "sprinkler", "hydrozone", "zone valve"], { isPrimaryJob: true }),
    standardPreset("drip_irrigation_install", "Drip Irrigation Install", "SERVICE", "FLAT", 180, 440, "Install drip lines and emitters for planting zones.", 1, ["drip irrigation", "drip line", "emitters", "hydrozoning", "zones"], { isPrimaryJob: true }),
    standardPreset("sprinkler_valve_replacement", "Sprinkler Valve Replacement", "SERVICE", "EACH", 65, 170, "Replace faulty irrigation valve/solenoid assembly.", 1, ["sprinkler valve", "irrigation valve", "solenoid"], { isPrimaryJob: false }),
    standardPreset("irrigation_controller_install", "Irrigation Controller Install", "SERVICE", "EACH", 120, 320, "Install and program irrigation timer/controller.", 1, ["irrigation controller", "sprinkler timer", "controller install", "smart controller", "rain sensor", "water budgeting"], { isPrimaryJob: false }),
    standardPreset("weed_control_treatment", "Weed Control Treatment", "SERVICE", "FLAT", 55, 145, "Targeted weed treatment for beds and hardscape edges.", 1, ["weed control", "weed treatment", "weed removal"], { isPrimaryJob: false }),
    standardPreset("yard_drainage_correction_allowance", "Yard Drainage Correction Allowance", "SERVICE", "FLAT", 180, 520, "Allowance for minor drainage correction in pooling areas.", 1, ["yard drainage", "pooling water", "drainage correction", "french drain"], { isPrimaryJob: false }),
    standardPreset("seasonal_cleanup", "Seasonal Cleanup", "SERVICE", "FLAT", 80, 195, "Debris and overgrowth cleanup.", 1, ["cleanup", "seasonal cleanup", "yard cleanup"], { isPrimaryJob: true }),
    standardPreset("green_waste_disposal", "Green Waste Disposal", "FEE", "FLAT", 20, 55, "Dump/disposal fee.", 1, ["green waste", "disposal", "haul away", "haul-away"], { isPrimaryJob: false }),
  ],
  CONSTRUCTION: [
    standardPreset("general_labor", "General Labor", "LABOR", "HOUR", 65, 140, "Construction labor hour.", 1, ["general labor", "labor"], { isPrimaryJob: true }),
    standardPreset("site_prep", "Site Prep", "SERVICE", "FLAT", 120, 320, "Site setup and preparation.", 1, ["site prep", "site preparation", "prep"], { isPrimaryJob: true }),
    standardPreset("framing_package", "Framing Package", "MATERIAL", "FLAT", 650, 1450, "Lumber and framing materials.", 1, ["framing", "frame", "lumber"], { isPrimaryJob: false }),
    standardPreset("demo_haul_away", "Demo + Haul Away", "SERVICE", "FLAT", 220, 540, "Demolition and disposal service.", 1, ["demo", "demolition", "haul away", "haul-away"], { isPrimaryJob: true }),
    standardPreset("project_management_fee", "Project Management Fee", "FEE", "FLAT", 0, 250, "Coordination and scheduling fee.", 1, ["project management", "coordination"], { isPrimaryJob: false }),
  ],
};

export function getStandardWorkPresetCatalog(serviceType: ServiceCategory): StandardWorkPresetDefinition[] {
  return STANDARD_WORK_PRESET_CATALOG[serviceType].map((preset) => ({ ...preset }));
}

export function getStandardWorkPresetDefinition(
  serviceType: ServiceCategory,
  catalogKey: string,
): StandardWorkPresetDefinition | null {
  return (
    STANDARD_WORK_PRESET_CATALOG[serviceType].find((preset) => preset.catalogKey === catalogKey) ?? null
  );
}

export function buildSquareFootBaselinePreset(
  serviceType: ServiceCategory,
  unitCost: number,
  unitPrice: number,
): StandardWorkPresetDefinition {
  return standardPreset(
    STANDARD_SQ_FT_BASE_CATALOG_KEY,
    `${serviceType} SQ FT Base`,
    "SERVICE",
    "SQ_FT",
    unitCost,
    unitPrice,
    "Square-foot baseline pricing preset.",
    100,
  );
}

function normalizeText(value: string): string {
  let normalized = value.toLowerCase();
  for (const [pattern, replacement] of MATCHING_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeNormalizedText(value: string): string[] {
  return value.split(" ").map((token) => token.trim()).filter((token) => token.length > 0);
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

function hasFuzzyTokenMatch(token: string, textTokens: string[]): boolean {
  if (token.length < 5) return false;
  for (const textToken of textTokens) {
    if (Math.abs(textToken.length - token.length) > 2) continue;
    const distance = levenshteinDistance(token, textToken);
    if (distance <= 1 || (token.length >= 8 && distance <= 2)) {
      return true;
    }
  }
  return false;
}

export interface StandardWorkPresetMatch {
  preset: StandardWorkPresetDefinition;
  score: number;
}

export function findStandardWorkPresetMatches(
  serviceType: ServiceCategory,
  text: string,
  options?: {
    primaryOnly?: boolean;
    excludeCatalogKeys?: string[];
    minimumScore?: number;
  },
): StandardWorkPresetMatch[] {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return [];
  const textTokens = tokenizeNormalizedText(normalizedText);

  const excluded = new Set(options?.excludeCatalogKeys ?? []);
  const matches: StandardWorkPresetMatch[] = [];
  for (const preset of STANDARD_WORK_PRESET_CATALOG[serviceType]) {
    if (options?.primaryOnly && !preset.isPrimaryJob) continue;
    if (excluded.has(preset.catalogKey)) continue;
    const keywords = preset.matchKeywords ?? [];
    let score = 0;

    for (const keyword of keywords) {
      const normalizedKeyword = normalizeText(keyword);
      if (!normalizedKeyword) continue;
      if (normalizedText.includes(normalizedKeyword)) {
        score += normalizedKeyword.includes(" ") ? 4 : 2;
        continue;
      }

      if (!normalizedKeyword.includes(" ") && hasFuzzyTokenMatch(normalizedKeyword, textTokens)) {
        score += 1;
      }
    }

    if (normalizedText.includes(normalizeText(preset.name))) {
      score += 5;
    }

    const catalogKeyKeywords = preset.catalogKey
      .split("_")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3);
    for (const token of catalogKeyKeywords) {
      if (normalizedText.includes(token)) {
        score += 1;
      } else if (hasFuzzyTokenMatch(token, textTokens)) {
        score += 1;
      }
    }

    if (preset.description) {
      const descriptionTokens = normalizeText(preset.description)
        .split(" ")
        .filter((token) => token.length >= 5);
      let descriptionHits = 0;
      for (const token of descriptionTokens) {
        if (normalizedText.includes(token)) {
          descriptionHits += 1;
        } else if (hasFuzzyTokenMatch(token, textTokens)) {
          descriptionHits += 1;
        }
        if (descriptionHits >= 3) break;
      }
      score += descriptionHits;
    }

    if (score >= (options?.minimumScore ?? 1)) {
      matches.push({ preset, score });
    }
  }

  return matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.preset.name.localeCompare(right.preset.name);
  });
}

export function findBestStandardWorkPresetMatch(
  serviceType: ServiceCategory,
  text: string,
  options?: {
    primaryOnly?: boolean;
    excludeCatalogKeys?: string[];
    minimumScore?: number;
  },
): StandardWorkPresetDefinition | null {
  return findStandardWorkPresetMatches(serviceType, text, options)[0]?.preset ?? null;
}
