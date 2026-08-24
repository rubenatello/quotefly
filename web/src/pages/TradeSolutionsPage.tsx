import { useEffect } from "react";
import {
  AirVent,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Clock3,
  FileCheck2,
  Hammer,
  HardHat,
  House,
  Layers3,
  PanelsTopLeft,
  Ruler,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
import { BASIC_PLAN_PRICING_PATH } from "../lib/plans";
import type { PublicRoutePath } from "../lib/public-seo-data";
import { setPublicSEOMetadata } from "../lib/seo";

export type TradeSolutionId = "hvac" | "plumbing" | "flooring" | "roofing" | "construction";

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
  pricingEyebrow: string;
  pricingHeading: string;
  pricingIntroduction: string;
  methods: readonly TradeMethod[];
  blueprintEyebrow: string;
  blueprintHeading: string;
  blueprintIntroduction: string;
  blueprint: readonly string[];
  jobs: readonly string[];
  workflowHeading: string;
  workflowDescription: string;
  workflowBenefits: readonly string[];
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
    workflowHeading: "Move from diagnosis to an approved HVAC quote quickly",
    workflowDescription: "Find the customer, assemble the system scope, review the branded PDF, and keep the quote visible for follow-up from the field or office.",
    workflowBenefits: ["Reusable equipment and service items", "Base scope separated from upgrades", "Customer-facing prices kept apart from internal cost", "Quote status and follow-up visibility"],
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
    workflowHeading: "Turn the on-site diagnosis into a quote the customer can act on",
    workflowDescription: "Capture the customer, build the repair path, review the branded PDF, and keep the next follow-up from disappearing after the service call.",
    workflowBenefits: ["Fast customer and quote lookup", "Repair and replacement options", "Reusable services and material items", "Clear quote status and follow-up"],
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
    workflowHeading: "Build the flooring quote before measurements turn into paperwork",
    workflowDescription: "Move from customer and room details to a clear branded estimate, then keep approvals and follow-up visible across phone and desktop.",
    workflowBenefits: ["Flexible square-foot quantities", "Prep work kept visible", "Reusable material and labor defaults", "Customer options without pricing confusion"],
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
    workflowHeading: "Keep the roofing estimate moving after the inspection",
    workflowDescription: "Capture the customer and scope, assemble the system, review the branded PDF, and make follow-up visible before the opportunity goes cold.",
    workflowBenefits: ["Detailed system line items", "Clear repair and decking allowances", "Customer choices without hidden scope", "Quote pipeline and follow-up visibility"],
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
    workflowHeading: "Turn the site walk into an estimate the customer can follow",
    workflowDescription: "Keep customer notes, project scope, pricing, branded PDFs, and follow-up together instead of rebuilding the job from disconnected documents.",
    workflowBenefits: ["Multi-phase quote structure", "Internal costs separated from customer pricing", "Allowances and alternates kept clear", "Mobile customer and follow-up workflow"],
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

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby={`${trade}-workflow-heading`}>
        <div className="mx-auto max-w-7xl rounded-[30px] bg-slate-950 p-7 text-white sm:p-10 lg:p-12">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-center">
            <div>
              <p className={`text-sm font-bold uppercase tracking-[0.18em] ${content.accent.badgeText}`}>From request to follow-up</p>
              <h2 id={`${trade}-workflow-heading`} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{content.workflowHeading}</h2>
              <p className="mt-4 text-lg leading-8 text-slate-300">{content.workflowDescription}</p>
            </div>
            <ul className="space-y-3">
              {content.workflowBenefits.map((item) => (
                <li key={item} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4 text-slate-100">
                  <Check size={18} className={`mt-0.5 shrink-0 ${content.accent.check}`} aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-8 flex flex-col gap-3 border-t border-white/10 pt-6 sm:flex-row sm:items-center">
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
          </div>
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
