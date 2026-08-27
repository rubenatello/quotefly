import { useEffect } from "react";
import {
  AirVent,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Hammer,
  HardHat,
  House,
  Layers3,
  Leaf,
  PanelsTopLeft,
  ReceiptText,
  Repeat2,
  Ruler,
  Settings2,
  ShieldCheck,
  Shovel,
  Sparkles,
  UserSearch,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
import { useMarketingReveal } from "../hooks/useMarketingReveal";
import { BASIC_PLAN_PRICING_PATH } from "../lib/plans";
import type { PublicRoutePath } from "../lib/public-seo-data";
import { setPublicSEOMetadata } from "../lib/seo";

export type TradeSolutionId = "hvac" | "plumbing" | "flooring" | "roofing" | "landscaping" | "construction";

type TradeMethod = {
  icon: LucideIcon;
  title: string;
  description: string;
};

type TradePageContent = {
  path: PublicRoutePath;
  name: string;
  icon: LucideIcon;
  badge: string;
  heading: string;
  introduction: string;
  heroImage: { src: string; alt: string; width: number; height: number };
  heroCallout: string;
  answer: string;
  operations: {
    intake: string;
    draft: string;
    job: string;
    visit: string;
  };
  pricingEyebrow: string;
  pricingHeading: string;
  pricingIntroduction: string;
  methods: readonly TradeMethod[];
  blueprintEyebrow: string;
  blueprintHeading: string;
  blueprintIntroduction: string;
  blueprint: readonly string[];
  jobs: readonly string[];
  kodyExample: {
    prompt: string;
    title: string;
    overview: string;
    lines: readonly string[];
  };
  buyerAnswers: readonly { question: string; answer: string }[];
  boundary: string;
  ctaTitle: string;
  ctaDescription: string;
  accent: {
    glow: string;
    badge: string;
    badgeText: string;
    eyebrow: string;
    icon: string;
    softBorder: string;
    softBackground: string;
    number: string;
    check: string;
  };
};

const OPERATING_STAGES = [
  { title: "Find or add the customer", icon: UserSearch, detailKey: "intake" },
  { title: "Prepare the quote", icon: Sparkles, detailKey: "draft" },
  { title: "Review and share", icon: FileCheck2, detailKey: null },
  { title: "Turn an accepted quote into a Job", icon: HardHat, detailKey: "job" },
  { title: "Assign, schedule, and dispatch", icon: CalendarDays, detailKey: "visit" },
  { title: "Record the internal invoice", icon: ReceiptText, detailKey: null },
] as const;

const TRADE_PAGES: Record<TradeSolutionId, TradePageContent> = {
  hvac: {
    path: "/solutions/hvac",
    name: "HVAC",
    icon: AirVent,
    badge: "HVAC estimating software",
    heading: "HVAC quotes that make repair and replacement options clear",
    introduction:
      "Build professional estimates for service calls, equipment replacements, ductwork, maintenance, and indoor-air upgrades while the diagnosis is still fresh.",
    heroImage: {
      src: "/images/solutions/hvac-service.jpg",
      alt: "HVAC technician servicing a residential outdoor air-conditioning condenser",
      width: 1536,
      height: 1024,
    },
    heroCallout: "Separate the base system, startup work, and customer upgrades without rebuilding the estimate.",
    answer:
      "QuoteFly helps HVAC contractors keep the customer, diagnosis, repair or replacement quote, accepted Job, technician visit, and internal invoice status connected in one small-team workspace.",
    operations: {
      intake: "Search the customer by name, phone, or email, or prepare a new contact for review while the service-call details are fresh.",
      draft: "Ask Kody for a structured first pass or load saved equipment, service, labor, startup, and upgrade items as separate lines.",
      job: "Carry the approved customer and HVAC scope into a numbered Job without rebuilding the accepted quote.",
      visit: "Assign an active technician, choose a day and time, and move an eligible appointment through dispatch, arrival, and completion.",
    },
    pricingEyebrow: "HVAC pricing that stays understandable",
    pricingHeading: "Give every part of the system the right pricing method",
    pricingIntroduction:
      "An HVAC estimate can combine diagnostic work, fixed-price equipment, technician time, and optional improvements. QuoteFly keeps those choices readable for both the office and the customer.",
    methods: [
      { icon: Settings2, title: "Diagnostic or service call", description: "Start with a clear flat-rate visit before defining the repair or replacement path." },
      { icon: Boxes, title: "Equipment and materials", description: "Price condensers, furnaces, air handlers, thermostats, fittings, and accessories as distinct work." },
      { icon: Clock3, title: "Labor and startup", description: "Account for installation time, commissioning, evacuation, testing, and crew requirements." },
      { icon: Sparkles, title: "Options and upgrades", description: "Offer efficiency upgrades, duct corrections, filtration, zoning, or maintenance without obscuring the base scope." },
    ],
    blueprintEyebrow: "A reusable HVAC quote blueprint",
    blueprintHeading: "Show the customer what is included before the crew arrives",
    blueprintIntroduction:
      "Save common equipment and service items, adjust the quantities for the home, and keep equipment assumptions and exclusions visible.",
    blueprint: ["Diagnosis, equipment, and installation scope", "Electrical, drain, refrigerant, and duct connections", "Startup, testing, permits, and disposal", "Efficiency, comfort, and maintenance options"],
    jobs: ["Repair visits", "System replacements", "Duct modifications", "Maintenance agreements"],
    kodyExample: {
      prompt: "Prepare an HVAC quote for Maya Thompson: diagnostic visit, condenser replacement, startup and testing, plus an optional thermostat upgrade.",
      title: "Condenser Replacement and Startup Quote",
      overview: "Replace the outdoor condenser, complete required connections, start up and test the system, and show the thermostat as a separate option.",
      lines: ["HVAC diagnostic visit", "Condenser and installation", "Startup and system testing", "Optional thermostat upgrade"],
    },
    buyerAnswers: [
      { question: "Can QuoteFly show repair and replacement paths?", answer: "Yes. Build separate customer-facing lines or quotes for the recommended repair, replacement equipment, startup work, and optional comfort upgrades." },
      { question: "Where do HVAC prices come from?", answer: "Your team controls saved product, service, labor, cost, and customer-price defaults. Kody does not invent local market rates." },
      { question: "What happens after the customer accepts?", answer: "An accepted quote can become a numbered Job, then an authorized user can assign and schedule the technician visit and record an internal invoice." },
    ],
    boundary: "QuoteFly does not perform Manual J calculations, select equipment capacity, provide distributor pricing, or replace a technician’s diagnosis.",
    ctaTitle: "Build an HVAC quote before the service details go cold",
    ctaDescription: "Try QuoteFly with a repair, replacement, ductwork, or maintenance estimate from your own workflow.",
    accent: {
      glow: "bg-cyan-400/20",
      badge: "border-cyan-200/20 bg-cyan-300/10",
      badgeText: "text-cyan-100",
      eyebrow: "text-blue-700",
      icon: "bg-blue-50 text-blue-700",
      softBorder: "border-blue-100",
      softBackground: "bg-blue-50/60",
      number: "bg-blue-700",
      check: "text-cyan-300",
    },
  },
  plumbing: {
    path: "/solutions/plumbing",
    name: "Plumbing",
    icon: Wrench,
    badge: "Plumbing estimating software",
    heading: "Plumbing quotes that keep diagnosis, repair, and replacement choices clear",
    introduction:
      "Create practical estimates for service work, fixture replacement, repiping, water heaters, drains, and remodel plumbing from one mobile-friendly workflow.",
    heroImage: {
      src: "/images/solutions/plumbing-service.jpg",
      alt: "Residential plumber repairing copper supply lines and valves beneath a kitchen sink",
      width: 1536,
      height: 1024,
    },
    heroCallout: "Keep the service call, primary repair, materials, and replacement option easy to compare.",
    answer:
      "QuoteFly helps plumbing contractors move from customer lookup and on-site diagnosis to a reviewed repair or replacement quote, an accepted Job, a scheduled service visit, and an internal invoice record.",
    operations: {
      intake: "Keep the caller, service address, access notes, and quote history together instead of splitting the request across calls and texts.",
      draft: "Use Kody or saved services to separate diagnosis, access, labor, fixtures, piping, testing, cleanup, and replacement options.",
      job: "Convert the accepted plumbing scope into a numbered Job with the customer and approved work already attached.",
      visit: "Assign a plumber, schedule the service or remodel visit, and update dispatch, arrival, and completion from the Jobs workspace.",
    },
    pricingEyebrow: "Flexible plumbing estimates",
    pricingHeading: "Price the diagnosis and the work that follows it",
    pricingIntroduction:
      "Plumbing scope often changes after access and diagnosis. QuoteFly lets you separate the initial visit from labor, fixtures, materials, and optional replacement work.",
    methods: [
      { icon: Wrench, title: "Service and diagnosis", description: "Use a clear trip or diagnostic charge before presenting the recommended work." },
      { icon: Clock3, title: "Labor by time", description: "Price troubleshooting, access, repair, and uncertain conditions by technician or crew hours." },
      { icon: Boxes, title: "Fixtures and materials", description: "Keep valves, piping, fittings, heaters, fixtures, disposal, and delivery visible." },
      { icon: Sparkles, title: "Repair or replacement", description: "Present a focused repair and a longer-term replacement option without mixing the totals." },
    ],
    blueprintEyebrow: "A reusable plumbing quote blueprint",
    blueprintHeading: "Set expectations around access, materials, and testing",
    blueprintIntroduction:
      "Build common repair and installation services once, then adjust quantities and site conditions without starting every estimate from a blank page.",
    blueprint: ["Service, diagnosis, and access", "Repair labor, fixtures, piping, and fittings", "Testing, cleanup, disposal, and restoration assumptions", "Replacement or preventive upgrade options"],
    jobs: ["Leak and drain repairs", "Fixture installation", "Water-heater work", "Repiping and remodels"],
    kodyExample: {
      prompt: "Prepare a plumbing quote for Daniel Reed: diagnose the leak, replace the kitchen faucet and shutoff valves, test, and clean up.",
      title: "Kitchen Faucet and Shutoff Valve Quote",
      overview: "Diagnose the leak, replace the faucet and accessible shutoff valves, test the connections, and leave the work area clean.",
      lines: ["Service and leak diagnosis", "Kitchen faucet replacement", "Shutoff valves and fittings", "Testing and cleanup"],
    },
    buyerAnswers: [
      { question: "Can a quote separate diagnosis from the repair?", answer: "Yes. Keep the service call, access work, labor, fixtures, piping, testing, and any replacement option on understandable lines." },
      { question: "Can QuoteFly account for uncertain access?", answer: "You can write assumptions, exclusions, and allowances into the overview and line items, then review them before sharing the quote." },
      { question: "Does acceptance create the plumbing Job automatically?", answer: "No hidden action occurs. An authorized user chooses when to create the Job from the accepted quote and when to schedule the visit." },
    ],
    boundary: "QuoteFly does not diagnose plumbing conditions, calculate code requirements, supply live material prices, or promise concealed work before access.",
    ctaTitle: "Create a plumbing estimate while the diagnosis is fresh",
    ctaDescription: "Try the customer-to-quote workflow with a service call, fixture, repipe, or water-heater job.",
    accent: {
      glow: "bg-teal-400/20",
      badge: "border-teal-200/20 bg-teal-300/10",
      badgeText: "text-teal-100",
      eyebrow: "text-cyan-700",
      icon: "bg-cyan-50 text-cyan-700",
      softBorder: "border-cyan-100",
      softBackground: "bg-cyan-50/60",
      number: "bg-cyan-700",
      check: "text-teal-300",
    },
  },
  flooring: {
    path: "/solutions/flooring",
    name: "Flooring",
    icon: PanelsTopLeft,
    badge: "Flooring estimating software",
    heading: "Flooring estimates that protect prep work, quantities, and margin",
    introduction:
      "Quote hardwood, laminate, vinyl, tile, carpet, demolition, subfloor preparation, transitions, and finishing with the details customers need to compare.",
    heroImage: {
      src: "/images/solutions/flooring-installation.jpg",
      alt: "Flooring installer aligning natural-oak planks in a bright residential room",
      width: 1536,
      height: 1024,
    },
    heroCallout: "Price square footage without losing demolition, prep, waste, transitions, and finish work.",
    answer:
      "QuoteFly helps flooring contractors keep measured scope, preparation, material, labor, customer options, the accepted installation Job, and scheduled crew visit connected without turning every quote into a new spreadsheet.",
    operations: {
      intake: "Find the customer and keep room notes, access details, selections, and prior quotes close to the new flooring request.",
      draft: "Organize measured quantities, demolition, subfloor preparation, material, waste, installation, stairs, transitions, and finish work.",
      job: "Move the accepted rooms, material choice, preparation scope, and customer into an installation Job for the team.",
      visit: "Assign the active installer or crew, schedule the work, and track eligible appointment states from dispatch through completion.",
    },
    pricingEyebrow: "Flooring quantities without hidden work",
    pricingHeading: "Use square-foot pricing without flattening the whole project",
    pricingIntroduction:
      "Material area is only one part of a flooring job. QuoteFly keeps preparation, removal, installation, waste, stairs, trims, and upgrades visible.",
    methods: [
      { icon: Ruler, title: "Material by square foot", description: "Price the selected flooring and installation quantity from the measured area." },
      { icon: Hammer, title: "Removal and preparation", description: "Keep demolition, leveling, moisture work, subfloor repair, and disposal separate." },
      { icon: Layers3, title: "Waste and complexity", description: "Account for pattern, layout, cuts, stairs, rooms, and the waste factor appropriate to the job." },
      { icon: Sparkles, title: "Transitions and finishes", description: "Add base, trim, thresholds, reducers, stairs, sealing, or premium finish options clearly." },
    ],
    blueprintEyebrow: "A reusable flooring quote blueprint",
    blueprintHeading: "Keep the measured area and the actual installation scope together",
    blueprintIntroduction:
      "Save common material and installation items, then adjust room measurements, preparation, and finish details for the project in front of you.",
    blueprint: ["Measurements, material, and waste allowance", "Removal, disposal, and floor preparation", "Installation pattern, rooms, stairs, and transitions", "Base, trim, finish, and optional upgrades"],
    jobs: ["Hardwood and engineered wood", "Luxury vinyl and laminate", "Tile installation", "Carpet and stair work"],
    kodyExample: {
      prompt: "Prepare a flooring quote for Priya Shah: 620 square feet of LVP, remove carpet, level two low spots, include 10% waste and new transitions.",
      title: "LVP Removal, Preparation, and Installation Quote",
      overview: "Remove existing carpet, prepare identified low areas, install selected LVP with reviewed waste quantity, and finish the listed transitions.",
      lines: ["Carpet removal and disposal", "Subfloor preparation allowance", "LVP material with reviewed waste", "Installation and transitions"],
    },
    buyerAnswers: [
      { question: "Does QuoteFly measure rooms or create takeoffs?", answer: "No. Enter measurements from your field process, then use quantities and reusable line items to build the customer quote." },
      { question: "Can prep work stay separate from square-foot pricing?", answer: "Yes. Demolition, leveling, moisture work, subfloor repair, stairs, transitions, and finish work can remain visible beside material and installation quantities." },
      { question: "How does approved flooring work reach the crew?", answer: "Create a Job from the accepted quote, assign an active teammate, and schedule the installation visit without re-entering the approved customer and scope." },
    ],
    boundary: "QuoteFly does not scan rooms, calculate automated takeoffs, choose a waste factor, verify moisture conditions, or provide supplier pricing.",
    ctaTitle: "Turn today’s flooring measurements into a clear quote",
    ctaDescription: "Try QuoteFly with a hardwood, vinyl, tile, carpet, or floor-preparation estimate.",
    accent: {
      glow: "bg-amber-400/20",
      badge: "border-amber-200/20 bg-amber-300/10",
      badgeText: "text-amber-100",
      eyebrow: "text-amber-700",
      icon: "bg-amber-50 text-amber-700",
      softBorder: "border-amber-100",
      softBackground: "bg-amber-50/60",
      number: "bg-amber-700",
      check: "text-amber-300",
    },
  },
  roofing: {
    path: "/solutions/roofing",
    name: "Roofing",
    icon: House,
    badge: "Roofing estimating software",
    heading: "Roofing quotes that make the full system and allowances visible",
    introduction:
      "Build clear estimates for repairs, tear-offs, reroofs, flashing, ventilation, decking allowances, disposal, and material upgrades from the field.",
    heroImage: {
      src: "/images/solutions/roofing-materials.jpg",
      alt: "Roofing contractor carrying packaged roofing materials across a residential roof",
      width: 1600,
      height: 1067,
    },
    heroCallout: "Show tear-off, underlayment, flashing, disposal, and deck allowances without burying the customer.",
    answer:
      "QuoteFly helps roofing contractors turn inspection details into a readable repair or reroof quote, keep allowances clear, move accepted work into a Job, and schedule the crew without rebuilding the customer record.",
    operations: {
      intake: "Search or prepare the customer record and keep roof notes, access details, requested material, and prior quote history together.",
      draft: "Structure repair or reroof scope around measured squares, tear-off, layers, underlayment, flashing, ventilation, disposal, and allowances.",
      job: "Carry the accepted roof system, customer, allowances, and options into a numbered Job for operational tracking.",
      visit: "Assign an active teammate, schedule the inspection or roofing visit, and use deliberate dispatch, arrival, and completion controls.",
    },
    pricingEyebrow: "Roofing scope customers can trust",
    pricingHeading: "Price the roof system, not only one lump sum",
    pricingIntroduction:
      "A useful roofing quote explains the system and the uncertainties. QuoteFly separates measured work, tear-off conditions, materials, accessories, and allowances.",
    methods: [
      { icon: Ruler, title: "Area and roofing squares", description: "Use measured area for roofing material, underlayment, ventilation, and installation quantities." },
      { icon: Layers3, title: "Tear-off and layers", description: "Keep removal, existing layers, disposal, loading, and site protection visible." },
      { icon: ShieldCheck, title: "System components", description: "Spell out flashing, valleys, penetrations, edge metal, vents, and waterproofing details." },
      { icon: Sparkles, title: "Allowances and upgrades", description: "Separate decking allowance, premium material, ventilation, and warranty options from the base scope." },
    ],
    blueprintEyebrow: "A reusable roofing quote blueprint",
    blueprintHeading: "Explain what protects the roof and what may change after tear-off",
    blueprintIntroduction:
      "Use repeatable roofing-system items and clear allowances so the customer understands both the base work and possible concealed conditions.",
    blueprint: ["Measurement, tear-off, loading, and disposal", "Underlayment, roofing material, flashing, and ventilation", "Decking and concealed-condition allowance", "Material, ventilation, and warranty upgrades"],
    jobs: ["Roof repairs", "Residential reroofs", "Low-slope systems", "Ventilation and flashing work"],
    kodyExample: {
      prompt: "Prepare a roofing quote for Alex Morgan: 24-square tear-off and reroof, synthetic underlayment, flashing, ridge vent, disposal, and a decking allowance.",
      title: "Residential Tear-Off and Reroof Quote",
      overview: "Remove the reviewed roof layers, install the specified roof system and ventilation, dispose of debris, and keep concealed decking work as an allowance.",
      lines: ["Tear-off, protection, and disposal", "Underlayment and roofing system", "Flashing and ridge ventilation", "Decking repair allowance"],
    },
    buyerAnswers: [
      { question: "Can QuoteFly separate known work from concealed damage?", answer: "Yes. Keep the reviewed roof system in the base scope and show decking or other concealed-condition work as a clear allowance." },
      { question: "Does QuoteFly calculate roof measurements?", answer: "No. Enter measurements from your inspection or measurement provider, then apply them to reusable roofing lines and reviewed customer prices." },
      { question: "Can an accepted reroof move into scheduling?", answer: "Yes. An authorized user can create a Job from the accepted quote, assign an active teammate, and schedule the work by day or week." },
    ],
    boundary: "QuoteFly does not provide aerial measurements, inspect roof conditions, select assemblies, supply live distributor prices, or automate supplement and insurance workflows.",
    ctaTitle: "Build a roofing quote while the inspection is still clear",
    ctaDescription: "Try QuoteFly with a repair, reroof, flashing, ventilation, or roof-system estimate.",
    accent: {
      glow: "bg-orange-400/20",
      badge: "border-orange-200/20 bg-orange-300/10",
      badgeText: "text-orange-100",
      eyebrow: "text-rose-700",
      icon: "bg-rose-50 text-rose-700",
      softBorder: "border-rose-100",
      softBackground: "bg-rose-50/60",
      number: "bg-rose-700",
      check: "text-orange-300",
    },
  },
  landscaping: {
    path: "/solutions/landscaping",
    name: "Landscaping",
    icon: Leaf,
    badge: "Landscaping estimating software",
    heading: "Landscaping quotes built around the way your crew works",
    introduction:
      "Create clear estimates for maintenance, planting, irrigation, cleanup, and installation using per-visit, hourly, area, material, and flat pricing in one reviewed quote.",
    heroImage: {
      src: "/images/solutions/landscaping-field-work.jpg",
      alt: "Landscaping professional preparing a planted garden bed beside a wheelbarrow",
      width: 1600,
      height: 1031,
    },
    heroCallout: "Mix recurring-service pricing, crew time, measured quantities, materials, and one-off installation work without hiding the scope.",
    answer:
      "QuoteFly helps landscaping contractors connect the customer and site request to a reviewed maintenance or installation quote, an accepted Job, a scheduled crew visit, and an internal invoice record.",
    operations: {
      intake: "Find or prepare the customer and keep site notes, access details, service preferences, and quote history in one searchable record.",
      draft: "Use Kody or saved services to separate cleanup, crew time, measured area, plants, soil, irrigation, equipment, delivery, and disposal.",
      job: "Carry the accepted maintenance visit or installation scope into a numbered Job without retyping the customer or approved work.",
      visit: "Assign an active crew member, schedule the visit, and move eligible appointments through dispatch, arrival, and completion.",
    },
    pricingEyebrow: "Flexible landscaping estimates",
    pricingHeading: "Use the pricing method that makes sense for each part of the property",
    pricingIntroduction:
      "Landscaping companies rarely price every service the same way. QuoteFly lets each line carry the right quantity and customer price while owners and admins keep internal cost private.",
    methods: [
      { icon: Repeat2, title: "Per visit or service plan", description: "Use a clear per-visit price for mowing, garden care, seasonal cleanup, and repeat maintenance options." },
      { icon: Clock3, title: "Hourly crew labor", description: "Price pruning, troubleshooting, hand work, and uncertain site conditions by reviewed crew time." },
      { icon: Ruler, title: "Area and quantity", description: "Estimate sod, mulch, planting, irrigation, or ground cover by square foot, yard, linear foot, or each." },
      { icon: Shovel, title: "Materials plus installation", description: "Keep plants, soil, disposal, delivery, equipment, and installation labor understandable in one quote." },
    ],
    blueprintEyebrow: "A reusable landscaping quote blueprint",
    blueprintHeading: "Start quickly without forcing every property into one flat rate",
    blueprintIntroduction:
      "Save common services as reusable work, adjust the reviewed quantity at the site, and keep installation scope, maintenance options, and exclusions readable for the customer.",
    blueprint: ["Site preparation, protection, cleanup, and haul-away", "Crew labor with the unit that matches the work", "Plants, soil, mulch, irrigation, equipment, and delivery", "Optional upgrades or a separately priced maintenance visit"],
    jobs: ["Seasonal cleanup", "Planting and bed installation", "Irrigation repair and additions", "Mowing and garden-care quotes"],
    kodyExample: {
      prompt: "Prepare a landscaping quote for Jordan Lee: spring cleanup, 8 yards of mulch, bed edging, delivery, and an optional monthly maintenance visit.",
      title: "Spring Cleanup and Mulch Installation Quote",
      overview: "Clean the reviewed areas, edge the beds, deliver and install the specified mulch quantity, and show monthly maintenance as a separate option.",
      lines: ["Spring cleanup and haul-away", "Bed edging", "Mulch, delivery, and installation", "Optional maintenance visit"],
    },
    buyerAnswers: [
      { question: "Can one quote mix landscaping pricing methods?", answer: "Yes. Use per-visit, hourly, square-foot, linear-foot, yard, each, and flat quantities on separate reviewed lines." },
      { question: "Does a maintenance option create recurring appointments or billing?", answer: "No. You can quote a maintenance visit or option, but recurring scheduling and automatic recurring billing are not created by that quote." },
      { question: "What happens when installation work is accepted?", answer: "An authorized user can create a Job from the accepted quote, assign an active teammate, schedule the visit, and later create an internal invoice record." },
    ],
    boundary: "QuoteFly does not measure the property, identify plants, design irrigation, supply local material rates, optimize routes, or automate recurring scheduling and billing.",
    ctaTitle: "Build a landscaping quote while the site details are fresh",
    ctaDescription: "Try QuoteFly with a cleanup, maintenance, planting, irrigation, or material-installation quote from your own workflow.",
    accent: {
      glow: "bg-lime-400/15",
      badge: "border-emerald-200/20 bg-emerald-300/10",
      badgeText: "text-emerald-100",
      eyebrow: "text-emerald-700",
      icon: "bg-emerald-50 text-emerald-700",
      softBorder: "border-emerald-100",
      softBackground: "bg-emerald-50/60",
      number: "bg-emerald-700",
      check: "text-lime-300",
    },
  },
  construction: {
    path: "/solutions/construction",
    name: "Construction",
    icon: HardHat,
    badge: "Construction estimating software",
    heading: "Construction quotes that organize complex work into a clear decision",
    introduction:
      "Build customer-ready estimates for renovations, additions, repairs, carpentry, general contracting, labor, materials, allowances, and alternates.",
    heroImage: {
      src: "/images/solutions/construction-framing.jpg",
      alt: "Construction professional framing the wall of a new residential structure",
      width: 1600,
      height: 1067,
    },
    heroCallout: "Organize phases, labor, materials, allowances, and alternates without turning the quote into a spreadsheet.",
    answer:
      "QuoteFly helps small construction teams connect customer intake, a phased estimate, human quote review, an accepted Job, scheduled field visits, and internal invoice status without adopting a full enterprise project-management suite.",
    operations: {
      intake: "Find or prepare the customer and keep the site walk, access notes, project request, and quote history connected.",
      draft: "Use Kody or saved work packages to organize phases, labor, material, equipment, subcontract scope, selections, allowances, and alternates.",
      job: "Move the accepted construction customer and approved scope into a numbered Job without rebuilding the commercial quote.",
      visit: "Assign active teammates, book a day and time, and track eligible site appointments through dispatch, arrival, and completion.",
    },
    pricingEyebrow: "Detailed construction estimates",
    pricingHeading: "Break down the project without making it hard to approve",
    pricingIntroduction:
      "Construction work can be detailed while the customer decision stays simple. QuoteFly keeps phases, quantities, allowances, and options in a readable scope.",
    methods: [
      { icon: HardHat, title: "Project and phase pricing", description: "Organize demolition, preparation, framing, finish work, and cleanup into understandable phases." },
      { icon: Clock3, title: "Labor and crew time", description: "Price defined labor or time-based work while keeping internal cost private from the customer." },
      { icon: Boxes, title: "Materials and allowances", description: "Separate supplied materials, fixtures, delivery, subcontract work, and customer selections." },
      { icon: Sparkles, title: "Alternates and upgrades", description: "Present upgrades or alternate approaches without confusing the approved base scope." },
    ],
    blueprintEyebrow: "A reusable construction quote blueprint",
    blueprintHeading: "Give detailed projects a consistent estimating structure",
    blueprintIntroduction:
      "Save common work packages and adjust quantities, selections, and site assumptions for each project while preserving a clear customer-facing scope.",
    blueprint: ["Demolition, access, protection, and preparation", "Labor, material, equipment, and subcontract scope", "Selections, allowances, exclusions, and schedule assumptions", "Upgrade alternates and optional work"],
    jobs: ["Renovations and additions", "General contracting", "Carpentry and repairs", "Tenant and finish improvements"],
    kodyExample: {
      prompt: "Prepare a construction quote for Rober California: build a custom dining table with $2,000 materials and $1,500 labor.",
      title: "Custom Wooden Dining Table Quote",
      overview: "Build a custom wooden table sized for the customer’s large dining area, with materials and labor shown separately for review.",
      lines: ["Custom wooden table materials", "Custom wooden table labor"],
    },
    buyerAnswers: [
      { question: "Can QuoteFly organize a multi-phase construction quote?", answer: "Yes. Use separate lines for preparation, labor, materials, equipment, subcontract scope, allowances, exclusions, and customer alternates." },
      { question: "Can the customer see internal cost or margin?", answer: "Customer-facing prices stay separate from owner- and admin-only internal cost information in normal quote, PDF, and share workflows." },
      { question: "Is QuoteFly full construction project-management software?", answer: "No. QuoteFly focuses on lightweight customer-to-quote-to-Job operations, scheduling, dispatch controls, and internal invoice records for small teams." },
    ],
    boundary: "QuoteFly does not perform takeoffs, supply market pricing, manage change-order contracts, run project accounting, or replace dedicated construction project-management software.",
    ctaTitle: "Turn the latest site details into a construction quote",
    ctaDescription: "Try QuoteFly with a renovation, addition, repair, carpentry, or general-contracting estimate.",
    accent: {
      glow: "bg-blue-400/20",
      badge: "border-blue-200/20 bg-blue-300/10",
      badgeText: "text-blue-100",
      eyebrow: "text-slate-700",
      icon: "bg-slate-100 text-slate-700",
      softBorder: "border-slate-200",
      softBackground: "bg-slate-50",
      number: "bg-slate-800",
      check: "text-blue-300",
    },
  },
};

export function TradeSolutionsPage({ trade, onOpenAuth }: { trade: TradeSolutionId; onOpenAuth: () => void }) {
  const content = TRADE_PAGES[trade];
  const TradeIcon = content.icon;

  useMarketingReveal();

  useEffect(() => {
    setPublicSEOMetadata(content.path);
  }, [content.path]);

  return (
    <div className="min-h-screen overflow-hidden bg-[#f7f4ee] text-slate-900">
      <section className="relative isolate overflow-hidden bg-slate-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-25" />
        <div aria-hidden="true" className={`qf-marketing-orbit qf-marketing-orbit--blue pointer-events-none absolute -left-24 top-10 -z-10 h-80 w-80 rounded-full blur-3xl ${content.accent.glow}`} />
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-14">
          <div className="qf-page-enter">
            <Link to={`/solutions#${trade}`} className="flex min-h-11 w-fit items-center gap-2 text-sm font-semibold text-slate-300 transition hover:text-white">
              <ArrowLeft size={16} aria-hidden="true" /> All trade solutions
            </Link>
            <p className={`mt-3 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold ${content.accent.badge} ${content.accent.badgeText}`}>
              <TradeIcon size={16} aria-hidden="true" /> {content.badge}
            </p>
            <h1 className="mt-6 text-4xl font-bold tracking-[-0.045em] text-white sm:text-5xl lg:text-[3.55rem] lg:leading-[1.03]">
              {content.heading}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl">{content.introduction}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>
                Start free trial
              </MarketingAction>
              <MarketingAction href="#pricing-methods" variant="dark-secondary">See {content.name.toLowerCase()} pricing methods</MarketingAction>
            </div>
          </div>

          <figure className="qf-hero-product relative min-h-[390px] overflow-hidden rounded-[30px] border border-white/15 bg-slate-900 shadow-[0_32px_90px_rgba(0,0,0,0.34)] sm:min-h-[520px]">
            <img
              src={content.heroImage.src}
              alt={content.heroImage.alt}
              width={content.heroImage.width}
              height={content.heroImage.height}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-slate-950/5" />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/20 bg-slate-950/80 p-4 backdrop-blur-md sm:inset-x-6 sm:bottom-6 sm:p-5">
              <p className={`text-xs font-bold uppercase tracking-[0.16em] ${content.accent.badgeText}`}>Quote the actual work</p>
              <p className="mt-1 text-base font-semibold text-white sm:text-lg">{content.heroCallout}</p>
            </div>
          </figure>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby={`${trade}-answer-heading`}>
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="grid gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-end">
            <div>
              <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.eyebrow}`}>The direct answer</p>
              <h2 id={`${trade}-answer-heading`} className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">How does QuoteFly help {content.name} contractors?</h2>
            </div>
            <p className="max-w-3xl text-lg leading-8 text-slate-600">{content.answer}</p>
          </div>

          <ol className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={`${content.name} customer-to-invoice workflow`}>
            {OPERATING_STAGES.map((stage, index) => {
              const StageIcon = stage.icon;
              const detail = stage.detailKey
                ? content.operations[stage.detailKey]
                : stage.title === "Review and share"
                  ? "Confirm the customer, overview, quantities, customer prices, and branded PDF before creating or sharing the quote."
                  : "Create an internal invoice record from eligible accepted or completed work and keep billing status visible; QuoteFly does not collect the customer payment.";
              return (
                <li key={stage.title} data-marketing-reveal className={`rounded-3xl border bg-slate-50 p-5 ${content.accent.softBorder}`} style={{ transitionDelay: `${(index % 3) * 45}ms` }}>
                  <div className="flex items-start justify-between gap-4">
                    <span className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl ${content.accent.icon}`}><StageIcon size={21} aria-hidden="true" /></span>
                    <span className="text-xs font-bold tracking-[0.16em] text-slate-600">0{index + 1}</span>
                  </div>
                  <h3 className="mt-4 text-lg font-bold text-slate-950">{stage.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{detail}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section id="pricing-methods" className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby={`${trade}-pricing-heading`}>
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto max-w-3xl text-center">
            <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.eyebrow}`}>{content.pricingEyebrow}</p>
            <h2 id={`${trade}-pricing-heading`} className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{content.pricingHeading}</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">{content.pricingIntroduction}</p>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {content.methods.map((method) => {
              const MethodIcon = method.icon;
              return (
                <article key={method.title} className={`rounded-3xl border bg-white p-6 shadow-[0_12px_34px_rgba(15,23,42,0.05)] ${content.accent.softBorder}`}>
                  <span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl ${content.accent.icon}`}>
                    <MethodIcon size={23} aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-bold text-slate-950">{method.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{method.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className={`border-y bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 ${content.accent.softBorder}`} aria-labelledby={`${trade}-blueprint-heading`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center lg:gap-14">
          <div>
            <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.eyebrow}`}>{content.blueprintEyebrow}</p>
            <h2 id={`${trade}-blueprint-heading`} className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{content.blueprintHeading}</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">{content.blueprintIntroduction}</p>
            <ol className="mt-8 space-y-3">
              {content.blueprint.map((item, index) => (
                <li key={item} className={`flex gap-4 rounded-2xl border p-4 ${content.accent.softBorder} ${content.accent.softBackground}`}>
                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white ${content.accent.number}`}>{index + 1}</span>
                  <span className="self-center font-semibold text-slate-800">{item}</span>
                </li>
              ))}
            </ol>
          </div>

          <aside className="rounded-[30px] bg-slate-950 p-7 text-white shadow-[0_24px_60px_rgba(15,23,42,0.16)] sm:p-9">
            <FileCheck2 size={30} className={content.accent.badgeText} aria-hidden="true" />
            <h3 className="mt-5 text-2xl font-bold">Built for common {content.name.toLowerCase()} work</h3>
            <p className="mt-3 leading-7 text-slate-300">Start with saved work, then adjust the scope, quantity, cost, and customer price for the job in front of you.</p>
            <ul className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {content.jobs.map((job) => (
                <li key={job} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4">
                  <Check size={18} className={`shrink-0 ${content.accent.check}`} aria-hidden="true" />
                  <span className="font-semibold text-slate-100">{job}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby={`${trade}-kody-heading`}>
        <div data-marketing-reveal className="mx-auto max-w-7xl overflow-hidden rounded-[30px] bg-slate-950 p-3 text-white shadow-[0_26px_66px_rgba(15,23,42,0.2)] sm:p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <div className="flex flex-col justify-center rounded-[24px] border border-white/10 bg-white/[0.04] p-6 sm:p-8 lg:p-10">
              <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.badgeText}`}>Kody-assisted first pass</p>
              <h2 id={`${trade}-kody-heading`} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Describe the {content.name.toLowerCase()} work in plain language.</h2>
              <p className="mt-4 text-base leading-7 text-slate-300">Kody can organize the customer, trade, title, overview, and separate line-item suggestions. Your team still confirms every scope detail, quantity, price, and action.</p>
              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">Fictional example request</p>
                <p className="mt-2 font-semibold leading-7 text-white">“{content.kodyExample.prompt}”</p>
              </div>
              <Link to="/solutions#kody" className="mt-6 inline-flex min-h-11 w-fit items-center gap-2 rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
                See the full guided Kody simulation <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>

            <div className="rounded-[24px] bg-slate-50 p-5 text-slate-900 sm:p-7 lg:p-9">
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-blue-700">Prepared quote structure</p>
                  <h3 className="mt-2 text-2xl font-bold text-slate-950">{content.kodyExample.title}</h3>
                </div>
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-800"><FileCheck2 size={14} aria-hidden="true" /> Review required</span>
              </div>
              <div className="py-5">
                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-500">Overview</p>
                <p className="mt-2 text-sm leading-6 text-slate-700">{content.kodyExample.overview}</p>
              </div>
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <p className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-500">Suggested separate line items</p>
                <ul>
                  {content.kodyExample.lines.map((line) => (
                    <li key={line} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 last:border-b-0">
                      <CheckCircle2 size={17} className={`shrink-0 ${content.accent.eyebrow}`} aria-hidden="true" /> {line}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />Sample content only. No AI API call or record mutation occurs on this page, and Kody does not supply market prices.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-12 sm:px-6 sm:py-16 lg:px-8" aria-labelledby={`${trade}-control-heading`}>
        <div data-marketing-reveal className="mx-auto max-w-7xl rounded-[30px] bg-slate-950 p-6 text-white sm:p-8 lg:p-10">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:items-center">
            <div>
              <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.badgeText}`}>Your team stays in control</p>
              <h2 id={`${trade}-control-heading`} className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Kody prepares. You confirm.</h2>
            </div>
            <aside className="flex items-start gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-6 text-amber-50">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-amber-200" aria-hidden="true" />
              <span><strong>Important boundary:</strong> {content.boundary}</span>
            </aside>
          </div>
          <div className="mt-6 flex flex-col gap-2 border-t border-white/10 pt-5 sm:flex-row sm:flex-wrap sm:items-center">
            <Link
              to="/solutions#workflow"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/20 px-4 text-sm font-semibold text-white transition hover:border-white/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:justify-start"
            >
              See the quote-to-job workflow <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link
              to={BASIC_PLAN_PRICING_PATH}
              className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-slate-200 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:justify-start"
            >
              See Basic pricing
            </Link>
            <Link
              to="/services"
              className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-slate-200 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:justify-start"
            >
              Compare QuoteFly capabilities
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby={`${trade}-questions-heading`}>
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="max-w-3xl">
            <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.eyebrow}`}>Practical buyer answers</p>
            <h2 id={`${trade}-questions-heading`} className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">What {content.name.toLowerCase()} teams usually want to know</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">Straight answers about where QuoteFly fits, what your team controls, and what happens after the quote.</p>
          </div>
          <dl className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
            {content.buyerAnswers.map((item) => (
              <div key={item.question} data-marketing-reveal className="py-6 sm:grid sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] sm:gap-8">
                <dt className="font-bold text-slate-950">{item.question}</dt>
                <dd className="mt-2 text-sm leading-6 text-slate-600 sm:mt-0">{item.answer}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-7 text-sm leading-6 text-slate-600">
            Explore the <Link to="/services" className="font-semibold text-quotefly-blue underline decoration-blue-200 underline-offset-4 hover:decoration-quotefly-blue">complete QuoteFly workflow</Link>, compare the <Link to={BASIC_PLAN_PRICING_PATH} className="font-semibold text-quotefly-blue underline decoration-blue-200 underline-offset-4 hover:decoration-quotefly-blue">Basic plan and current limits</Link>, or return to <Link to="/solutions" className="font-semibold text-quotefly-blue underline decoration-blue-200 underline-offset-4 hover:decoration-quotefly-blue">all contractor solutions</Link>.
          </p>
        </div>
      </section>

      <MarketingCta
        title={content.ctaTitle}
        description={content.ctaDescription}
        actionLabel="Start free trial"
        onAction={onOpenAuth}
        supportingText={<span className="inline-flex items-center gap-2"><FileCheck2 size={15} aria-hidden="true" /> Human review stays required before sending.</span>}
      />
    </div>
  );
}
