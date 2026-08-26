import {
  Prisma,
  type ActivityTaskPriority,
  type ActivityTaskStatus,
  type ActivityTaskType,
  type AiPurpose,
  type AiUsageEventType,
  type DataClassification,
  type PrismaClient,
  type ServiceCategory,
} from "@prisma/client";
import { env } from "../config/env";
import {
  AI_ASSISTANT_TOOLS,
  type AiAssistantConversationState,
  type AiAssistantConversationTurn,
  type AiAssistantRequestedTool,
  type AiAssistantTool,
} from "./ai-assistant-contract";
import type { AccessContext } from "./access-policy";
import { hasCapability } from "./access-policy";
import type { ActivityActor } from "./activity";
import {
  composeAssistantAnswer,
  type AiAssistantAnswerMode,
  type AiAssistantCompositionResult,
} from "./ai-assistant-composer";
import { governAiPrompt, hashSourceReference } from "./ai-data-governance";
import {
  createAiUsageEvent,
  mergeAiUsageTelemetry,
  type AiUsageTelemetry,
  type MonthlyAiUsageSnapshot,
} from "./ai-usage";
import {
  AiBusinessInsightForbiddenError,
  generateAiBusinessInsight,
  type AiBusinessInsightTool,
} from "./ai-business-insights";
import { buildGovernedQuoteAiContext, type AiRetrievalResult } from "./ai-retrieval";
import { isAiRagEnabledForTenant, isAiRagExposedForTenant } from "./ai-rag-rollout";
import { AI_DATA_POLICY_VERSION } from "./data-classification";
import { formatUsPhone, normalizePhoneSearchDigits, normalizeUsPhoneDigits } from "./phone";
import { tenantActiveCustomerScope, tenantActiveQuoteScope } from "./query-scope";
import {
  shiftTenantLocalDate,
  tenantActivityWindows,
  tenantLocalDateParts,
  tenantWallTimeToUtc,
} from "./tenant-time";
import { withTenantRlsContext } from "./tenant-rls";
import {
  summarizeAssistantActivityAgenda,
  type AssistantActivityTaskProjection,
} from "../services/activity-tasks";
import {
  listAssistantSchedule,
  prepareAssistantBooking,
  prepareAssistantDispatch,
} from "../services/ai-schedule-tools";
import { prepareCatalogQuoteLines } from "../services/ai-quote-catalog";
import { createAiQuoteProviderBudget } from "../services/ai-quote";
import { parseChatToQuotePrompt } from "../services/chat-to-quote";
import { AiUsageLedgerError } from "../services/ai-usage-ledger";
import { visibleJobWhere } from "../services/jobs";
import type { SupportedLocale } from "./supported-locale";

export { AI_ASSISTANT_TOOLS } from "./ai-assistant-contract";
export type { AiAssistantRequestedTool, AiAssistantTool } from "./ai-assistant-contract";

export type AiAssistantContext = Readonly<{
  currentPage?: "quotes" | "customers" | "analytics" | "products" | "dashboard" | "follow-up" | "jobs";
  customerId?: string;
  quoteId?: string;
  jobId?: string;
  invoiceId?: string;
  appointmentId?: string;
  search?: string;
  serviceType?: ServiceCategory;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  limit?: number;
  includeArchived?: boolean;
}>;

export type AiAssistantAction = Readonly<{
  type:
    | "OPEN_CUSTOMER"
    | "OPEN_CUSTOMER_DRAFT"
    | "OPEN_PRODUCT_DRAFT"
    | "OPEN_ACTIVITY_DRAFT"
    | "OPEN_SCHEDULE"
    | "OPEN_BOOKING_REVIEW"
    | "OPEN_DISPATCH_REVIEW"
    | "OPEN_QUOTE_DRAFT"
    | "OPEN_QUOTE_SEND"
    | "OPEN_ANALYTICS"
    | "OPEN_WORKSPACE_PAGE"
    | "REQUEST_ADMIN_ACCESS";
  label: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
}>;

export type AiAssistantCitation = Readonly<{
  key: string;
  label: string;
  sourceType: string;
  classification: DataClassification;
}>;

export type AiAssistantResult = Readonly<{
  tool: AiAssistantTool;
  generatedAtUtc: Date;
  policyVersion: string;
  maxClassification: DataClassification;
  answer: string;
  results: Array<Record<string, string | number | boolean | null>>;
  citations: AiAssistantCitation[];
  actions: AiAssistantAction[];
  auditEventId: string;
  fieldsExcluded: string[];
  diagnostics: AiAssistantDiagnostics;
  conversation?: AiAssistantConversationState;
}>;

export type AiAssistantRunResult = Readonly<{
  assistant: AiAssistantResult;
  consumedCredits: number;
  consumedSpendUsd: number;
}>;

export type AiAssistantDiagnostics = Readonly<{
  requestedTool: AiAssistantRequestedTool;
  resolvedTool: AiAssistantTool;
  resultCount: number;
  citationCount: number;
  emptyReason: string | null;
  archivePolicy: string;
  filters: Readonly<Record<string, string | number | boolean | null>>;
  answerMode: AiAssistantAnswerMode;
  model: string | null;
}>;

export type AiAssistantInput = Readonly<{
  access: AccessContext;
  actor: ActivityActor;
  message: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
  conversation?: readonly AiAssistantConversationTurn[];
  now?: Date;
  usageSnapshot?: MonthlyAiUsageSnapshot;
  preferredLocale?: SupportedLocale;
}>;

const DEFAULT_CUSTOMER_LIMIT = 5;
const MAX_CUSTOMER_LIMIT = 8;
const DEFAULT_PRODUCT_LIMIT = 5;
const MAX_PRODUCT_LIMIT = 8;
const DEFAULT_OPERATIONAL_RECORD_LIMIT = 5;
const MAX_OPERATIONAL_RECORD_LIMIT = 8;
const DEFAULT_ACTIVITY_LIMIT = 5;
const MAX_ACTIVITY_LIMIT = 8;
const DEFAULT_SCHEDULE_LIMIT = 8;
const OPEN_PIPELINE_STATUSES = ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER"] as const;
const ACTIVE_ACTIVITY_STATUSES: ActivityTaskStatus[] = ["OPEN", "IN_PROGRESS"];
const ZERO_AI_TELEMETRY: AiUsageTelemetry = Object.freeze({
  requestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
});
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  C0_PUBLIC: 0,
  C1_BUSINESS_INTERNAL: 1,
  C2_CUSTOMER_CONFIDENTIAL: 2,
  C3_FINANCIAL_CONFIDENTIAL: 3,
  C4_RESTRICTED: 4,
};

function assignedCustomerScope(access: AccessContext): Prisma.CustomerWhereInput {
  return hasCapability(access, "viewAllWorkspaceRecords")
    ? {}
    : { assignedTenantUserId: access.tenantUserId };
}

function assignedQuoteScope(access: AccessContext): Prisma.QuoteWhereInput {
  return hasCapability(access, "viewAllWorkspaceRecords")
    ? {}
    : { assignedTenantUserId: access.tenantUserId };
}

function highestClassification(...values: readonly DataClassification[]) {
  return values.reduce<DataClassification>(
    (current, value) => CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[current] ? value : current,
    "C0_PUBLIC",
  );
}
const STOP_CUSTOMER_SEARCH_PREFIX =
  /^(?:please\s+|por\s+favor\s+)?(?:find|search|look\s+up|show|show\s+me|open|buscar|busca|encontrar|encuentra|mostrar|muestra|muestrame|abrir|abre)\s+(?:a\s+|al\s+|el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?(?:customer|client|contact|customers|clients|contacts|cliente|clientes|contacto|contactos)\s*(?:named|called|for|matching|with|llamado|llamada|que\s+se\s+llama|con)?\s*/i;
const FINANCIAL_INTENT_PATTERN = /\b(profit|profitable|profitability|margin|gross|cost|costs|rank|underpriced|low[-\s]*margin|ganancia|ganancias|rentabilidad|rentable|margen|margenes|costo|costos|clasificar|clasifica|ordenar|ordena)\b/i;
const PIPELINE_INTENT_PATTERN = /\b(pipeline|sales|revenue|win\s*rate|accepted|sent|open\s+quotes?|follow[-\s]*up|forecast|projection|projected|ventas|ingresos|tasa\s+de\s+cierre|aceptad[ao]s?|enviad[ao]s?|cotizaci(?:on|ones)\s+abiertas?|seguimiento|pronostico|proyecci(?:on|ones)|proyectad[ao]s?)\b/i;
const CUSTOMER_INTENT_PATTERN = /\b(customer|client|contact|phone|email|find|search|look\s+up|cliente|clientes|contacto|contactos|telefono|correo|buscar|busca|encontrar|encuentra)\b/i;
const JOB_STATUS_INTENT_PATTERN = /\b(?:status|state|progress|where\s+(?:is|are)|what(?:'s|\s+is)\s+happening\s+with|estado|progreso|donde\s+esta|como\s+va)\b.{0,72}\b(?:job|work\s+order|trabajo|obra)\b|\b(?:job|work\s+order|trabajo|obra)\b.{0,72}\b(?:status|state|progress|estado|progreso|como\s+va)\b/i;
const JOB_SEARCH_INTENT_PATTERN = /\b(?:find|search|look\s*up|show|list|open|which|what|buscar|busca|encontrar|encuentra|mostrar|muestra|muestrame|listar|lista|abrir|abre|cual|cuales|que)\b.{0,72}\b(?:jobs?|work\s+orders?|trabajos?|obras?)\b|\b(?:jobs?|work\s+orders?|trabajos?|obras?)\b.{0,72}\b(?:find|search|look\s*up|show|list|open|buscar|busca|mostrar|muestra|muestrame|listar|lista|abrir|abre)\b/i;
const INVOICE_STATUS_INTENT_PATTERN = /\b(?:status|state|payment|paid|balance|due|overdue|estado|pago|pagada?|saldo|vence|vencida?)\b.{0,72}\b(?:invoice|bill|factura|cobro)\b|\b(?:invoice|bill|factura|cobro)\b.{0,72}\b(?:status|state|payment|paid|balance|due|overdue|estado|pago|pagada?|saldo|vence|vencida?)\b/i;
const INVOICE_LIST_INTENT_PATTERN = /\b(?:find|search|look\s*up|show|list|open|which|what|buscar|busca|encontrar|encuentra|mostrar|muestra|muestrame|listar|lista|abrir|abre|cual|cuales|que)\b.{0,72}\b(?:invoices?|bills?|facturas?|cobros?)\b|\b(?:invoices?|bills?|facturas?|cobros?)\b.{0,72}\b(?:find|search|look\s*up|show|list|open|buscar|busca|mostrar|muestra|muestrame|listar|lista|abrir|abre)\b/i;
const QUOTE_DRAFT_INTENT_PATTERN = /\b(quote|estimate|draft|bid|proposal|new\s+job|sq\s*ft|sqft|roof|roofing|floor|flooring|hvac|plumb|plumbing|landscap|construction|cotizacion|presupuesto|estimado|propuesta|borrador|nuevo\s+trabajo|pies?\s+cuadrados?|techo|techado|piso|pisos|plomeria|jardineria|paisajismo|construccion)\b/i;
const ACTIVITY_TASK_INTENT_PATTERN =
  /\b(?:my\s+(?:day|tasks?|to[-\s]*dos?|work|activities|follow[-\s]*ups?)|(?:active|open|due)\s+tasks?|tasks?\s+(?:assigned|due|open|active)|tasks?.{0,24}assigned\s+to\s+me|to[-\s]*dos?|activity|activities|work\s+assigned|assigned\s+(?:work|tasks?)|mis\s+(?:tareas|seguimientos|actividades)|mi\s+dia|trabajo\s+asignado|tareas?\s+(?:activas?|asignadas?|pendientes?|para\s+hoy)|tareas?.{0,24}asignadas?|que\s+tengo\s+que\s+hacer|seguimientos?\s+asignados?)\b/i;
const PRIORITIZE_MY_DAY_PATTERN =
  /\b(?:prioriti[sz]e|what\s+should\s+i\s+do\s+first|where\s+should\s+i\s+start|plan\s+my\s+day|organize\s+my\s+day|organise\s+my\s+day|my\s+day|top\s+priorit(?:y|ies)|prioriza|priorizar|que\s+hago\s+primero|por\s+donde\s+empiezo|organiza\s+mi\s+dia|mis\s+prioridades|prioridades\s+de\s+hoy)\b/i;
const PREPARE_ACTIVITY_INTENT_PATTERN =
  /(?:\b(?:add|create|make|schedule|set\s+up|remind|reminder|agregar|agrega|crear|crea|hacer|programar|programa|recordar|recordatorio)\b.{0,96}\b(?:task|to[-\s]*do|follow[-\s]*up|reminder|activity|tarea|seguimiento|recordatorio|actividad)\b)|(?:\b(?:follow\s+up\s+with|call|dar\s+seguimiento\s+a|llamar)\b.{0,96}\b[\p{L}\p{N}][\p{L}\p{N}\s.'-]{1,80})|(?:\b(?:task|to[-\s]*do|follow[-\s]*up|reminder|activity|tarea|seguimiento|recordatorio|actividad)\b.{0,96}\b(?:for|with|to|para|con|a)\b)/iu;
const PREPARE_DISPATCH_INTENT_PATTERN =
  /(?:\b(?:dispatch|send\s+out|despachar|despacha|enviar\s+al\s+trabajo)\b.{0,96}\b(?:job|crew|technician|appointment|visit|trabajo|equipo|tecnico|cita|visita)\b)|(?:\b(?:job|appointment|visit|trabajo|cita|visita)\b.{0,96}\b(?:dispatch|despachar|despacha)\b)/i;
const PREPARE_BOOKING_INTENT_PATTERN =
  /(?:\b(?:book|schedule|reschedule|set\s+up|agendar|agenda|programar|programa|reagendar|reagenda)\b.{0,96}\b(?:job|work|appointment|visit|trabajo|obra|cita|visita)\b)|(?:\b(?:job|work|appointment|visit|trabajo|obra|cita|visita)\b.{0,96}\b(?:book|schedule|reschedule|agendar|agenda|programar|programa|reagendar|reagenda)\b)/i;
const LIST_SCHEDULE_INTENT_PATTERN =
  /\b(?:my\s+schedule|our\s+schedule|team\s+schedule|today(?:'s)?\s+(?:schedule|appointments?|bookings?)|tomorrow(?:'s)?\s+(?:schedule|appointments?|bookings?)|schedule\s+(?:today|tomorrow|this\s+week|for\s+the\s+week)|appointments?\s+(?:today|tomorrow|this\s+week)|what(?:'s|\s+is)\s+(?:on\s+)?(?:my|our|the|today(?:'s)?|tomorrow(?:'s)?)?\s*schedule|mi\s+agenda|nuestro\s+calendario|agenda\s+(?:de\s+)?(?:hoy|manana|esta\s+semana)|citas?\s+(?:de\s+)?(?:hoy|manana|esta\s+semana)|que\s+(?:tengo|tenemos|hay)\s+(?:en\s+)?(?:mi|nuestra|la)?\s*(?:agenda|calendario))\b/i;
const ACTIVITY_TODAY_INTENT_PATTERN = /\b(?:today|this\s+morning|this\s+afternoon|tonight|hoy|esta\s+ma(?:n|ñ)ana|esta\s+tarde|esta\s+noche)\b/i;
const FOLLOW_UP_INTENT_PATTERN = /\bfollow(?:ed|ing)?[-\s]+up\b|\bfollow[-\s]*up\b|\b(?:dar|hacer|necesita|necesitan|requiere|requieren|pendiente(?:s)?\s+de)\s+seguimiento\b|\bseguimiento(?:s)?\b/i;
const CUSTOMERS_WITHOUT_QUOTES_PATTERN =
  /\b(?:customers?|clients?|clientes?)\b.{0,64}\b(?:do\s+not\s+have|does\s+not\s+have|don't\s+have|doesn't\s+have|have\s+no|has\s+no|without|missing|no\s+tienen?|sin|les?\s+falta)\b.{0,40}\b(?:quotes?|estimates?|proposals?|cotizaci(?:on|ones)|presupuestos?|estimados?|propuestas?)\b/i;
const PIPELINE_SCENARIO_PATTERN =
  /(?:\b(?:close|closed|convert|converted|win|won|sell|sold|attain|attained|land|landed|realize|realized|cerrar|cerramos|cerrara|convertir|convertimos|ganar|ganamos|vender|vendemos|lograr|logramos)\b.{0,64}\b(?:\d{1,3}(?:\.\d+)?\s*(?:%|percent|por\s+ciento)|open\s+(?:quotes?|pipeline)|cotizaci(?:on|ones)\s+abiertas?|pipeline)\b)|(?:\b\d{1,3}(?:\.\d+)?\s*(?:%|percent|por\s+ciento)\b.{0,64}\b(?:open\s+quotes?|pipeline|revenue|cotizaci(?:on|ones)\s+abiertas?|ingresos?)\b)/i;
const PRODUCT_DRAFT_INTENT_PATTERN =
  /(?:\b(?:add|create|make|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda|configurar|configura)\b.{0,72}\b(?:product|service|catalog\s+item|line[-\s]*item|producto|servicio|articulo\s+del\s+catalogo|partida)\b)|(?:\b(?:product|service|catalog\s+item|line[-\s]*item|producto|servicio|articulo\s+del\s+catalogo|partida)\b.{0,72}\b(?:add|create|make|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda|configurar|configura)\b)/i;
const PRODUCT_SEARCH_INTENT_PATTERN =
  /(?:\b(?:find|search|look\s*up|show|list|which|what|buscar|busca|encontrar|encuentra|mostrar|muestra|muestrame|listar|lista|cual|cuales|que)\b.{0,72}\b(?:products?|services?|catalog(?:\s+items?)?|line[-\s]*items?|productos?|servicios?|catalogo|partidas?)\b)|(?:\b(?:products?|services?|catalog(?:\s+items?)?|line[-\s]*items?|productos?|servicios?|catalogo|partidas?)\b.{0,72}\b(?:do\s+(?:i|we)\s+have|find|search|look\s*up|show|list|tengo|tenemos|buscar|busca|mostrar|muestra|muestrame|listar|lista)\b)|(?:\b(?:do\s+(?:i|we)\s+have|tengo|tenemos|hay)\b.{0,72}\b(?:products?|services?|catalog(?:\s+items?)?|line[-\s]*items?|productos?|servicios?|catalogo|partidas?)\b)|(?:\b(?:is|are|esta|estan)\b.{0,72}\b(?:en\s+)?(?:my|our|the|mi|nuestro|el)\s+(?:catalog|products?|services?|catalogo|productos?|servicios?)\b)/i;
const CUSTOMER_DRAFT_INTENT_PATTERN =
  /(?:\b(?:add|create|save|set\s+up|new|agregar|agrega|anadir|anade|crear|crea|guardar|guarda|nuevo|nueva)\b.{0,56}\b(?:customer(?!\s+(?:price|pricing|amount|rate))|client|contact|cliente|contacto)\b)|(?:\b(?:customer(?!\s+(?:price|pricing|amount|rate))|client|contact|cliente|contacto)\b.{0,56}\b(?:add|create|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda)\b)/i;
const CUSTOMER_DRAFT_COMMAND_PATTERN =
  /^(?:please\s+|por\s+favor\s+)?(?:add|create|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda)\b/i;
const QUOTE_SEND_INTENT_PATTERN =
  /(?:\b(?:send|email|text|share|enviar|envia|mandar|manda|correo|texto|compartir|comparte)\b.{0,72}\b(?:quote|estimate|proposal|cotizacion|presupuesto|estimado|propuesta)\b)|(?:\b(?:quote|estimate|proposal|cotizacion|presupuesto|estimado|propuesta)\b.{0,72}\b(?:send|email(?!\s*(?:address\s*)?(?:is\s*)?[:=-]?\s*[A-Z0-9._%+-]+@)|text|share|enviar|envia|mandar|manda|correo(?!\s*(?:electronico\s*)?(?:es\s*)?[:=-]?\s*[A-Z0-9._%+-]+@)|texto|compartir|comparte)\b)/i;
const CUSTOMER_DRAFT_DETAIL_PATTERN =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i;
const QUOTE_SEND_FOLLOW_UP_PATTERN =
  /^(?:send|email|text|share|use\s+(?:email|text)|the\s+(?:first|second|third|latest)|for\s+|to\s+|enviar|envia|correo|texto|compartir|comparte|usa\s+(?:correo|texto)|la\s+(?:primera|segunda|tercera|ultima)|el\s+(?:primero|segundo|tercero|ultimo)|para\s+|a\s+)/i;
const QUOTE_WORK_DETAIL_PATTERN =
  /\b(?:hvac|plumb(?:ing)?|roof(?:ing)?|floor(?:ing)?|garden(?:ing)?|landscap(?:ing)?|construction|repair|replace(?:ment)?|install(?:ation)?|inspect(?:ion)?|diagnos(?:e|is|tic)|service|maintenance|clean(?:ing|up)?|labor|material|fixture|faucet|toilet|sink|heater|pipe|drain|sewer|hours?|hrs?|sq\s*ft|sqft|square\s+feet|techo|plomeria|piso|jardineria|paisajismo|construccion|reparacion|reemplazo|instalacion|inspeccion|servicio|mano\s+de\s+obra|horas?)\b/i;
const NAVIGATION_VERB_PATTERN = /\b(?:go|open|navigate|take\s+me|bring\s+me|move\s+me|show\s+me|ir|ve|abrir|abre|navegar|navega|llevame|moverme|muestrame)\b/i;
const CONVERSATION_FOLLOW_UP_PATTERN =
  /^(?:and\b|also\b|what\s+about\b|how\s+about\b|now\b|same\b|show\s+me\s+more\b|which\s+(?:one|ones)\b|break\s+(?:that|it)\s+down\b|compare\s+(?:that|them|those)\b|y\b|ademas\b|ahora\b|que\s+tal\b|y\s+si\b|muestrame\s+mas\b|cual(?:es)?\b|compara\b)/i;
const ASSISTANT_HELP_PATTERN =
  /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|help|what\s+can\s+you\s+do|how\s+can\s+you\s+help|who\s+are\s+you|what\s+is\s+kody|hola|buenos\s+dias|buenas\s+tardes|buenas\s+noches|ayuda|que\s+puedes\s+hacer|como\s+puedes\s+ayudar(?:me)?|quien\s+eres|que\s+es\s+kody)[\s.!?]*$/i;
const INSTRUCTION_OVERRIDE_PATTERN =
  /\b(?:ignore|disregard|override|forget|ignora|omita|omite|desobedece|anula|olvida)\b.{0,48}\b(?:instructions?|system|developer|safety\s+rules?|rules?|policy|guardrails?|instrucciones?|sistema|desarrollador|reglas?|politica|protecciones?)\b/i;
const SENSITIVE_SCOPE_ESCAPE_PATTERN =
  /\b(?:system\s+prompt|developer\s+message|hidden\s+prompt|jailbreak|bypass\s+(?:the\s+)?(?:tenant|policy|guardrails?)|cross[-\s]*tenant|(?:another|other)\s+tenant(?:'s|s)?|api\s+key|secret\s+token|prompt\s+del\s+sistema|mensaje\s+del\s+desarrollador|prompt\s+oculto|evita(?:r)?\s+(?:el\s+)?(?:tenant|inquilino|espacio\s+de\s+trabajo|politica|protecciones?)|datos?\s+de\s+(?:otro|otra)\s+(?:tenant|inquilino|cuenta|empresa|espacio\s+de\s+trabajo)|(?:otro|otra)\s+(?:tenant|inquilino|cuenta|empresa|espacio\s+de\s+trabajo)|clave\s+(?:de\s+)?api|token\s+secreto|contrasena|secreto)\b/i;
const OUTSIDE_KNOWLEDGE_PATTERN =
  /\b(?:weather|weather\s+forecast|headline|news|politics|election|sports?|celebrity|movie|television|recipe|cooking|joke|poem|story|homework|medical\s+advice|diagnos(?:e|is)|legal\s+advice|stock\s+tip|invest(?:ment|ing)|cryptocurrency|write\s+code|programming|clima|pronostico\s+del\s+clima|noticias?|politica|elecciones?|deportes?|celebridad|pelicula|television|receta|cocina|chiste|poema|cuento|tareas?\s+escolares?|consejo\s+medico|diagnostico|consejo\s+legal|acciones?|inversiones?|criptomoneda|escribe\s+codigo|programacion)\b/i;
const CONTEXTUAL_ENTITY_QUERY_PATTERN =
  /^(?!.*\b(?:what|why|how|when|where|who|tell|explain|write|give|could|would|should)\b)[\p{L}\p{N}][\p{L}\p{N}\s.'@()+&/-]{0,80}$/iu;

type AssistantTopic = "CRM" | "QUOTING" | "SENDING" | "PRODUCTS" | "SCHEDULING" | "INSIGHTS" | "NAVIGATION" | "HELP";

function assistantLocale(params: Pick<AiAssistantInput, "preferredLocale">): SupportedLocale {
  return params.preferredLocale === "es-US" ? "es-US" : "en-US";
}

function isSpanishAssistant(params: Pick<AiAssistantInput, "preferredLocale">) {
  return assistantLocale(params) === "es-US";
}

function localeText(
  params: Pick<AiAssistantInput, "preferredLocale">,
  english: string,
  spanish: string,
) {
  return isSpanishAssistant(params) ? spanish : english;
}

function normalizeAssistantRoutingText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[¿¡]+|[¿¡]+$/g, "");
}

function assistantTopic(tool: AiAssistantTool): AssistantTopic {
  if (tool === "ASSISTANT_HELP" || tool === "OUT_OF_SCOPE") return "HELP";
  if ([
    "SEARCH_CUSTOMERS",
    "SEARCH_JOBS",
    "GET_JOB_STATUS",
    "FOLLOW_UP_QUEUE",
    "CUSTOMERS_WITHOUT_QUOTES",
    "DRAFT_CUSTOMER",
    "LIST_MY_ACTIVITIES",
    "PRIORITIZE_MY_DAY",
    "PREPARE_ACTIVITY",
  ].includes(tool)) return "CRM";
  if (tool === "DRAFT_QUOTE") return "QUOTING";
  if (tool === "PREPARE_QUOTE_SEND") return "SENDING";
  if (tool === "LIST_SCHEDULE" || tool === "PREPARE_BOOKING" || tool === "PREPARE_DISPATCH") return "SCHEDULING";
  if (tool === "DRAFT_PRODUCT" || tool === "SEARCH_PRODUCTS") return "PRODUCTS";
  if (tool === "NAVIGATE_WORKSPACE") return "NAVIGATION";
  return "INSIGHTS";
}

function assistantTopicLabel(topic: AssistantTopic, locale: SupportedLocale) {
  const spanish = locale === "es-US";
  if (topic === "SCHEDULING") return spanish ? "la agenda de trabajos" : "job scheduling";
  if (topic === "CRM") return spanish ? "el seguimiento de clientes" : "customer follow-up";
  if (topic === "QUOTING") return spanish ? "la preparación de una cotización" : "building a quote";
  if (topic === "SENDING") return spanish ? "la preparación de una cotización para enviar" : "preparing a quote to send";
  if (topic === "PRODUCTS") return spanish ? "la configuración de un producto o servicio" : "setting up a product or service";
  if (topic === "INSIGHTS") return spanish ? "los análisis del negocio" : "business insights";
  if (topic === "HELP") return spanish ? "la ayuda de QuoteFly" : "QuoteFly help";
  return spanish ? "la navegación del espacio de trabajo" : "workspace navigation";
}

function previousOperationalTool(conversation: readonly AiAssistantConversationTurn[] | undefined) {
  return [...(conversation ?? [])]
    .reverse()
    .find((turn) => turn.resolvedTool !== "ASSISTANT_HELP" && turn.resolvedTool !== "OUT_OF_SCOPE")
    ?.resolvedTool ?? null;
}

export function resolveAssistantConversationState(
  conversation: readonly AiAssistantConversationTurn[] | undefined,
  currentTool: AiAssistantTool,
  locale: SupportedLocale = "en-US",
): AiAssistantConversationState {
  const previousTool = previousOperationalTool(conversation);
  if (currentTool === "ASSISTANT_HELP" || currentTool === "OUT_OF_SCOPE") {
    return { mode: "NEW", acknowledgement: null, previousTool, currentTool };
  }
  if (!previousTool) {
    return { mode: "NEW", acknowledgement: null, previousTool: null, currentTool };
  }

  const previousTopic = assistantTopic(previousTool);
  const currentTopic = assistantTopic(currentTool);
  if (previousTopic === currentTopic || previousTopic === "NAVIGATION" || currentTopic === "NAVIGATION") {
    return { mode: "CONTINUING", acknowledgement: null, previousTool, currentTool };
  }

  return {
    mode: "SHIFTED",
    acknowledgement: locale === "es-US"
      ? `Entendido: cambiamos de ${assistantTopicLabel(previousTopic, locale)} a ${assistantTopicLabel(currentTopic, locale)}. Usaré tu solicitud más reciente.`
      : `Got it — we're switching from ${assistantTopicLabel(previousTopic, locale)} to ${assistantTopicLabel(currentTopic, locale)}. I'll use your latest request.`,
    previousTool,
    currentTool,
  };
}
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "called",
  "can",
  "client",
  "clients",
  "contact",
  "contacts",
  "customer",
  "customers",
  "find",
  "for",
  "include",
  "look",
  "matching",
  "named",
  "or",
  "please",
  "retrieve",
  "search",
  "show",
  "so",
  "tenant",
  "tenantid",
  "too",
  "up",
  "with",
  "you",
  "al",
  "asignado",
  "asignados",
  "buscar",
  "busca",
  "cliente",
  "clientes",
  "con",
  "contacto",
  "contactos",
  "de",
  "el",
  "encontrar",
  "encuentra",
  "la",
  "llamado",
  "llamada",
  "los",
  "las",
  "mi",
  "mostrar",
  "muestra",
  "muestrame",
  "por",
  "reciente",
  "recientes",
  "mis",
  "un",
  "una",
]);

const CUSTOMER_DRAFT_PHONE_PATTERN = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const CUSTOMER_DRAFT_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CUSTOMER_DRAFT_GENERIC_NAME_PATTERN = /^(?:(?:a|un|una)\s+)?(?:(?:new|nuevo|nueva)\s+)?(?:customer|client|contact|cliente|contacto)$/i;
const QUOTE_SEND_STOP_WORDS = new Set([
  "a",
  "an",
  "by",
  "customer",
  "email",
  "estimate",
  "for",
  "latest",
  "my",
  "please",
  "prepare",
  "proposal",
  "quote",
  "saved",
  "selected",
  "send",
  "share",
  "text",
  "the",
  "this",
  "to",
  "using",
  "via",
  "a",
  "cliente",
  "correo",
  "cotizacion",
  "enviar",
  "envia",
  "estimado",
  "mandar",
  "manda",
  "para",
  "el",
  "la",
  "los",
  "las",
  "mi",
  "mis",
  "presupuesto",
  "propuesta",
  "texto",
  "ultima",
  "ultimo",
]);
const PRODUCT_SEARCH_STOP_WORDS = new Set([
  "active",
  "all",
  "approved",
  "are",
  "available",
  "catalog",
  "do",
  "find",
  "have",
  "i",
  "in",
  "item",
  "items",
  "is",
  "list",
  "look",
  "me",
  "my",
  "our",
  "product",
  "products",
  "search",
  "service",
  "services",
  "show",
  "the",
  "up",
  "use",
  "we",
  "what",
  "which",
  "activo",
  "activos",
  "buscar",
  "busca",
  "catalogo",
  "cual",
  "cuales",
  "disponible",
  "disponibles",
  "encontrar",
  "encuentra",
  "hay",
  "listar",
  "lista",
  "mi",
  "mostrar",
  "muestra",
  "muestrame",
  "nuestro",
  "mis",
  "producto",
  "productos",
  "que",
  "servicio",
  "servicios",
  "tengo",
  "tenemos",
  "todos",
  "todas",
]);

type CustomerDraftPreview = Readonly<{
  fullName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}>;

function extractCustomerDraftName(message: string) {
  const commandMatch = message.match(
    /\b(?:add|create|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda)\s+(?:(?:a|un|una)\s+)?(?:(?:new|nuevo|nueva)\s+)?(?:customer|client|contact|cliente|contacto)(?:\s+(?:new|nuevo|nueva))?(?:\s+(?:named|called|llamado|llamada|que\s+se\s+llama))?\s+([^,;\n]+)/i,
  );
  const withoutContactDetails = message
    .replace(CUSTOMER_DRAFT_EMAIL_PATTERN, " ")
    .replace(CUSTOMER_DRAFT_PHONE_PATTERN, " ")
    .replace(/\b(?:phone|mobile|cell|email|e-mail|notes?|telefono|celular|correo|correo\s+electronico|notas?)\s*[:=-]?/gi, " ")
    .replace(/^\s*(?:add|create|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda)?\s*(?:(?:a|un|una)\s+)?(?:(?:new|nuevo|nueva)\s+)?(?:customer|client|contact|cliente|contacto)?(?:\s+(?:new|nuevo|nueva))?(?:\s+(?:named|called|llamado|llamada|que\s+se\s+llama))?\s*/i, "")
    .split(/[,;\n]/, 1)[0]
    ?.trim();
  const candidate = (commandMatch?.[1] ?? withoutContactDetails ?? "")
    .replace(/\b(?:phone|mobile|cell|email|e-mail|notes?|telefono|celular|correo|correo\s+electronico|notas?)\b.*$/i, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .slice(0, 120);
  if (
    candidate.length < 2
    || CUSTOMER_DRAFT_GENERIC_NAME_PATTERN.test(candidate)
    || !/^[\p{L}][\p{L}\p{M}.'-]*(?:\s+[\p{L}][\p{L}\p{M}.'-]*){0,5}$/u.test(candidate)
  ) return null;
  return candidate;
}

function parseCustomerDraft(message: string): CustomerDraftPreview {
  const phoneRaw = message.match(CUSTOMER_DRAFT_PHONE_PATTERN)?.[0] ?? null;
  const phoneDigits = normalizeUsPhoneDigits(phoneRaw);
  const email = message.match(CUSTOMER_DRAFT_EMAIL_PATTERN)?.[0]?.toLowerCase() ?? null;
  const notesMatch = message.match(/\b(?:notes?|notas?)\s*[:=-]\s*([^\n]{1,500})/i);
  return {
    fullName: extractCustomerDraftName(message),
    phone: phoneDigits ? formatUsPhone(phoneDigits) : null,
    email,
    notes: notesMatch?.[1]?.trim().slice(0, 500) || null,
  };
}

const ACTIVITY_SEARCH_STOP_WORDS = new Set([
  ...SEARCH_STOP_WORDS,
  "activity",
  "assigned",
  "call",
  "create",
  "due",
  "follow",
  "followup",
  "make",
  "me",
  "my",
  "remind",
  "reminder",
  "schedule",
  "task",
  "today",
  "tomorrow",
  "todo",
  "with",
  "actividad",
  "asignada",
  "asignadas",
  "crear",
  "crea",
  "hoy",
  "llamar",
  "manana",
  "mañana",
  "para",
  "programar",
  "programa",
  "recordatorio",
  "seguimiento",
  "tarea",
  "tareas",
]);

type ActivityDraftPreview = Readonly<{
  type: ActivityTaskType;
  priority: ActivityTaskPriority;
  title: string;
  dueAtUtc: Date;
  dueTimeSource: "EXPLICIT" | "DEFAULT";
  dueTimeWarning: "NONEXISTENT_LOCAL_TIME" | null;
  customerSearch: string;
}>;

type ActivityDueTimeResult = Readonly<{
  dueAtUtc: Date;
  source: "EXPLICIT" | "DEFAULT";
  warning: "NONEXISTENT_LOCAL_TIME" | null;
}>;

function activityCustomerSearch(message: string, contextSearch?: string) {
  const explicit = contextSearch?.trim();
  if (explicit) return explicit.slice(0, 120);
  const match = message.match(
    /\b(?:for|with|to|customer|client|contact|para|con|a|cliente|contacto)\s+([\p{L}\p{M}0-9][\p{L}\p{M}0-9 .'-]{1,80}?)(?=\s+(?:today|tomorrow|next\s+week|in\s+\d+|about|on|at|hoy|ma(?:n|ñ)ana|proxima\s+semana|en\s+\d+|sobre|acerca|por)\b|[,.;]|$)/iu,
  )?.[1];
  const candidate = (match ?? message)
    .replace(CUSTOMER_DRAFT_EMAIL_PATTERN, " ")
    .replace(CUSTOMER_DRAFT_PHONE_PATTERN, " ")
    .split(/[,.!?;\n]/, 1)[0]
    ?.trim() ?? "";
  const tokens = candidate
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !ACTIVITY_SEARCH_STOP_WORDS.has(token.toLowerCase()))
    .slice(0, 6);
  return tokens.join(" ").slice(0, 120);
}

function parseActivityType(message: string): ActivityTaskType {
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  if (/\b(?:send|email|text|share|enviar|envia|mandar|manda|correo|texto|compartir)\b/.test(normalized)) {
    return "SEND_QUOTE";
  }
  if (/\b(?:quote|estimate|proposal|cotizacion|presupuesto|estimado|propuesta)\b/.test(normalized)) {
    return "PREPARE_QUOTE";
  }
  if (/\b(?:check[-\s]*in|post[-\s]*job|after[-\s]*sale|completed\s+job|revision|revisar|trabajo\s+terminado|post[-\s]*venta)\b/.test(normalized)) {
    return "CHECK_IN";
  }
  if (/\b(?:follow[-\s]*up|call|remind|seguimiento|llamar|recordatorio)\b/.test(normalized)) {
    return "FOLLOW_UP";
  }
  return "CUSTOM";
}

function parseActivityPriority(message: string): ActivityTaskPriority {
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  if (/\b(?:urgent|asap|immediately|critical|urgente|ya|inmediato|critico)\b/.test(normalized)) return "URGENT";
  if (/\b(?:high|important|priority|importante|prioridad|alta)\b/.test(normalized)) return "HIGH";
  if (/\b(?:low|whenever|baja|cuando\s+se\s+pueda)\b/.test(normalized)) return "LOW";
  return "NORMAL";
}

function parseActivityClockTime(message: string): { hour: number; minute: number } | null {
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  const match = normalized.match(
    /\b(?:at|@|a\s+las|para\s+las)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/i,
  ) ?? normalized.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (!match?.[1]) return null;
  const rawHour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.replace(/\./g, "").toLowerCase();
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === "am") {
    if (rawHour < 1 || rawHour > 12) return null;
    return { hour: rawHour === 12 ? 0 : rawHour, minute };
  }
  if (meridiem === "pm") {
    if (rawHour < 1 || rawHour > 12) return null;
    return { hour: rawHour === 12 ? 12 : rawHour + 12, minute };
  }
  if (rawHour < 0 || rawHour > 23) return null;
  if (rawHour >= 1 && rawHour <= 6) return { hour: rawHour + 12, minute };
  return { hour: rawHour, minute };
}

function activityDueDate(
  message: string,
  generatedAtUtc: Date,
  windows: { todayStartUtc: Date; tomorrowStartUtc: Date; timeZone: string },
) {
  return activityDueTime(message, generatedAtUtc, windows).dueAtUtc;
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  const explicitTime = parseActivityClockTime(message);
  const oneHourFromNow = new Date(generatedAtUtc.getTime() + 60 * 60 * 1_000);
  const today = tenantLocalDateParts(generatedAtUtc, windows.timeZone);
  const dueFromLocal = (
    date: Pick<typeof today, "year" | "month" | "day">,
    fallback: Date,
    defaultHour = today.hour,
    defaultMinute = today.minute,
  ) => tenantWallTimeToUtc({
    ...date,
    hour: explicitTime?.hour ?? defaultHour,
    minute: explicitTime?.minute ?? defaultMinute,
  }, windows.timeZone) ?? fallback;
  const inDays = normalized.match(/\b(?:in|en)\s+(\d{1,2})\s+(?:days?|dias?)\b/);
  if (inDays?.[1]) {
    const days = Math.min(Math.max(Number(inDays?.[1] ?? 0), 0), 30);
    return dueFromLocal(shiftTenantLocalDate(today, days), oneHourFromNow);
  }
  if (/\b(?:next\s+week|proxima\s+semana)\b/.test(normalized)) {
    return dueFromLocal(shiftTenantLocalDate(today, 7), oneHourFromNow);
  }
  if (/\b(?:tomorrow|manana|mañana)\b/.test(normalized)) {
    return dueFromLocal(shiftTenantLocalDate(today, 1), oneHourFromNow, 9, 0);
  }
  if (ACTIVITY_TODAY_INTENT_PATTERN.test(normalized)) {
    const dueAt = dueFromLocal(today, oneHourFromNow, 9, 0);
    return dueAt > generatedAtUtc ? dueAt : oneHourFromNow;
  }
  return new Date(generatedAtUtc.getTime() + 60 * 60 * 1_000);
}

function activityDueTime(
  message: string,
  generatedAtUtc: Date,
  windows: { timeZone: string },
): ActivityDueTimeResult {
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  const explicitTime = parseActivityClockTime(message);
  const oneHourFromNow = new Date(generatedAtUtc.getTime() + 60 * 60 * 1_000);
  const today = tenantLocalDateParts(generatedAtUtc, windows.timeZone);
  const wallTime = (
    date: Pick<typeof today, "year" | "month" | "day">,
    hour: number,
    minute: number,
  ) => tenantWallTimeToUtc({ ...date, hour, minute }, windows.timeZone);
  const defaultForDate = (date: Pick<typeof today, "year" | "month" | "day">) =>
    wallTime(date, 9, 0) ?? oneHourFromNow;
  const explicitForDate = (date: Pick<typeof today, "year" | "month" | "day">) => {
    if (!explicitTime) return null;
    return wallTime(date, explicitTime.hour, explicitTime.minute);
  };
  const exactOrDefault = (date: Pick<typeof today, "year" | "month" | "day">): ActivityDueTimeResult => {
    const exact = explicitForDate(date);
    if (exact) return { dueAtUtc: exact, source: "EXPLICIT", warning: null };
    return {
      dueAtUtc: defaultForDate(date),
      source: "DEFAULT",
      warning: explicitTime ? "NONEXISTENT_LOCAL_TIME" : null,
    };
  };
  const inDays = normalized.match(/\b(?:in|en)\s+(\d{1,2})\s+(?:days?|dias?)\b/);
  if (inDays?.[1]) {
    const targetDate = shiftTenantLocalDate(today, Math.min(Math.max(Number(inDays?.[1] ?? 0), 0), 30));
    if (explicitTime) return exactOrDefault(targetDate);
    return {
      dueAtUtc: wallTime(targetDate, today.hour, today.minute) ?? oneHourFromNow,
      source: "DEFAULT",
      warning: null,
    };
  }
  if (/\b(?:next\s+week|proxima\s+semana)\b/.test(normalized)) {
    const targetDate = shiftTenantLocalDate(today, 7);
    if (explicitTime) return exactOrDefault(targetDate);
    return {
      dueAtUtc: wallTime(targetDate, today.hour, today.minute) ?? oneHourFromNow,
      source: "DEFAULT",
      warning: null,
    };
  }
  if (/\b(?:tomorrow|manana|mañana)\b/.test(normalized)) {
    const targetDate = shiftTenantLocalDate(today, 1);
    if (explicitTime) return exactOrDefault(targetDate);
    return { dueAtUtc: defaultForDate(targetDate), source: "DEFAULT", warning: null };
  }
  if (explicitTime) {
    const exactToday = explicitForDate(today);
    if (exactToday && exactToday > generatedAtUtc) {
      return { dueAtUtc: exactToday, source: "EXPLICIT", warning: null };
    }
    const exactTomorrow = explicitForDate(shiftTenantLocalDate(today, 1));
    if (exactTomorrow) return { dueAtUtc: exactTomorrow, source: "EXPLICIT", warning: null };
    return { dueAtUtc: oneHourFromNow, source: "DEFAULT", warning: "NONEXISTENT_LOCAL_TIME" };
  }
  if (ACTIVITY_TODAY_INTENT_PATTERN.test(normalized)) {
    const dueAtUtc = defaultForDate(today);
    return { dueAtUtc: dueAtUtc > generatedAtUtc ? dueAtUtc : oneHourFromNow, source: "DEFAULT", warning: null };
  }
  return { dueAtUtc: oneHourFromNow, source: "DEFAULT", warning: null };
}

function parseActivityDraft(
  message: string,
  generatedAtUtc: Date,
  windows: { todayStartUtc: Date; tomorrowStartUtc: Date; timeZone: string },
  locale: SupportedLocale,
  contextSearch?: string,
): ActivityDraftPreview {
  const type = parseActivityType(message);
  const priority = parseActivityPriority(message);
  const customerSearch = activityCustomerSearch(message, contextSearch);
  const fallbackTitle = locale === "es-US"
    ? type === "SEND_QUOTE" ? "Enviar cotización"
      : type === "PREPARE_QUOTE" ? "Preparar cotización"
        : type === "CHECK_IN" ? "Revisar con el cliente"
          : type === "FOLLOW_UP" ? "Dar seguimiento al cliente"
            : "Tarea del espacio"
    : type === "SEND_QUOTE" ? "Send quote"
      : type === "PREPARE_QUOTE" ? "Prepare quote"
        : type === "CHECK_IN" ? "Customer check-in"
          : type === "FOLLOW_UP" ? "Follow up with customer"
            : "Workspace task";
  const quotedTitle = message.match(/["“]([^"”]{3,120})["”]/)?.[1]?.trim();
  const dueTime = activityDueTime(message, generatedAtUtc, windows);
  return {
    type,
    priority,
    title: (quotedTitle ?? fallbackTitle).slice(0, 160),
    dueAtUtc: dueTime.dueAtUtc,
    dueTimeSource: dueTime.source,
    dueTimeWarning: dueTime.warning,
    customerSearch,
  };
}

function quoteSendSearchTokens(message: string) {
  return message
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !QUOTE_SEND_STOP_WORDS.has(token))
    .slice(0, 5);
}

function clampLimit(value: number | undefined, max: number, fallback: number) {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function cleanSearchQuery(message: string, contextSearch?: string) {
  let raw = contextSearch?.trim() || message.trim().replace(STOP_CUSTOMER_SEARCH_PREFIX, "").trim();
  raw = raw.split(/\b(?:(?:and|y)\s+)?(?:ignore|bypass|override|expose|retrieve\s+all|show\s+all|ignora|evita|anula|expone|recupera\s+todo|muestra\s+todo)\b/i)[0] ?? raw;
  const cleaned = raw.replace(/\s+/g, " ").slice(0, 120);
  return /^(?:please\s+|por\s+favor\s+)?(?:find|search|show(?:\s+me)?|look\s+up|buscar|busca|mostrar|muestra|muestrame|encontrar|encuentra)?\s*(?:(?:my|assigned|active|recent|mis?|asignados?|activos?|recientes?)\s+)*(?:customers?|clients?|contacts?|clientes?|contactos?)$/i.test(normalizeAssistantRoutingText(cleaned))
    ? ""
    : cleaned;
}

function cleanProductSearchQuery(message: string, contextSearch?: string) {
  if (contextSearch?.trim()) return contextSearch.trim().slice(0, 120);
  let raw = message.trim();
  raw = raw.split(/\b(?:(?:and|y)\s+)?(?:ignore|bypass|override|expose|retrieve\s+all|show\s+all|ignora|evita|anula|expone|recupera\s+todo|muestra\s+todo)\b/i)[0] ?? raw;
  const meaningfulTokens = raw
    .normalize("NFKC")
    .match(/[\p{L}\p{N}][\p{L}\p{N}+&.'/-]*/gu)
    ?.filter((token) => !PRODUCT_SEARCH_STOP_WORDS.has(token.toLowerCase()))
    .slice(0, 8) ?? [];
  return meaningfulTokens.join(" ").slice(0, 120);
}

function searchableTokens(search: string) {
  return search
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
    .slice(0, 6);
}

type AiWorkspaceTarget = "customers" | "quotes" | "products" | "follow-up" | "analytics" | "build";

function navigationTarget(message: string): AiWorkspaceTarget | null {
  if (!NAVIGATION_VERB_PATTERN.test(message)) return null;
  if (/\b(?:profit|profitable|profitability|margin|gross|cost|costs|rank|underpriced|low[-\s]*margin)\b/i.test(message)) {
    return null;
  }
  if (/\b(?:new|create|draft|build|nueva|nuevo|crear|crea|preparar|prepara)\s+(?:a\s+|una\s+|un\s+)?(?:quote|estimate|proposal|cotizacion|presupuesto|propuesta)\b/i.test(message)) return "build";
  if (/\b(?:products?|services?|catalog|pricing|productos?|servicios?|catalogo|precios?)\b/i.test(message)) return "products";
  if (FOLLOW_UP_INTENT_PATTERN.test(message)) return "follow-up";
  if (/\b(?:analytics|reports?|insights?|dashboard|analitica|analisis|reportes?|informes?|panel)\b/i.test(message)) return "analytics";
  if (
    /\b(?:go|navigate|take\s+me|bring\s+me|move\s+me|ir|ve|navega|llevame|moverme)\b.{0,40}\b(?:customers?|clients?|contacts?|clientes?|contactos?)\b/i.test(message) ||
    /\b(?:open|abre|abrir)\s+(?:the\s+|a\s+|el\s+|la\s+|los\s+|las\s+)?(?:customers?|clients?|contacts?|clientes?|contactos?)(?:\s+(?:page|list|tab|screen|pagina|lista|pestana|pantalla))?\s*[.!?]*$/i.test(message)
  ) return "customers";
  if (
    /\b(?:go|navigate|take\s+me|bring\s+me|move\s+me|ir|ve|navega|llevame|moverme)\b.{0,40}\b(?:quotes?|estimates?|proposals?|cotizaci(?:on|ones)|presupuestos?|estimados?|propuestas?)\b/i.test(message) ||
    /\b(?:open|abre|abrir)\s+(?:the\s+|a\s+|el\s+|la\s+|los\s+|las\s+)?(?:quotes?|estimates?|proposals?|cotizaci(?:on|ones)|presupuestos?|estimados?|propuestas?)(?:\s+(?:page|list|tab|screen|pagina|lista|pestana|pantalla))?\s*[.!?]*$/i.test(message)
  ) return "quotes";
  return null;
}

export function resolveAssistantTool(
  message: string,
  requestedTool?: AiAssistantRequestedTool,
  context?: AiAssistantContext,
  conversation?: readonly AiAssistantConversationTurn[],
): AiAssistantTool {
  const normalizedMessage = normalizeAssistantRoutingText(message);
  if (OUTSIDE_KNOWLEDGE_PATTERN.test(normalizedMessage)) return "OUT_OF_SCOPE";
  const overrideMatch = INSTRUCTION_OVERRIDE_PATTERN.exec(normalizedMessage);
  if (overrideMatch?.index === 0) return "OUT_OF_SCOPE";
  const routingMessage = overrideMatch?.index
    ? normalizedMessage.slice(0, overrideMatch.index).trim()
    : normalizedMessage;
  if (SENSITIVE_SCOPE_ESCAPE_PATTERN.test(routingMessage)) return "OUT_OF_SCOPE";
  const previousTool = previousOperationalTool(conversation);

  // A review-only product draft is a stronger intent than a stale UI tool
  // selection. This also protects older clients that opened Kody from a
  // customer-specific button and then replaced the suggested prompt.
  if (PRODUCT_DRAFT_INTENT_PATTERN.test(routingMessage)) return "DRAFT_PRODUCT";
  if (PREPARE_ACTIVITY_INTENT_PATTERN.test(routingMessage)) return "PREPARE_ACTIVITY";
  if (PREPARE_DISPATCH_INTENT_PATTERN.test(routingMessage)) return "PREPARE_DISPATCH";
  if (PREPARE_BOOKING_INTENT_PATTERN.test(routingMessage)) return "PREPARE_BOOKING";
  if (LIST_SCHEDULE_INTENT_PATTERN.test(routingMessage)) return "LIST_SCHEDULE";
  const autoSelectOperationalLookup = !requestedTool || requestedTool === "AUTO";
  if (autoSelectOperationalLookup && INVOICE_STATUS_INTENT_PATTERN.test(routingMessage)) return "GET_INVOICE_STATUS";
  if (autoSelectOperationalLookup && INVOICE_LIST_INTENT_PATTERN.test(routingMessage)) return "LIST_INVOICES";
  if (autoSelectOperationalLookup && JOB_STATUS_INTENT_PATTERN.test(routingMessage)) return "GET_JOB_STATUS";
  if (autoSelectOperationalLookup && JOB_SEARCH_INTENT_PATTERN.test(routingMessage)) return "SEARCH_JOBS";
  if (PRIORITIZE_MY_DAY_PATTERN.test(routingMessage)) return "PRIORITIZE_MY_DAY";
  if (ACTIVITY_TASK_INTENT_PATTERN.test(routingMessage)) return "LIST_MY_ACTIVITIES";
  if (
    previousTool === "DRAFT_QUOTE"
    && CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage)
    && !CUSTOMER_DRAFT_COMMAND_PATTERN.test(routingMessage)
  ) return "DRAFT_QUOTE";
  if (
    CUSTOMER_DRAFT_INTENT_PATTERN.test(routingMessage)
    && !QUOTE_DRAFT_INTENT_PATTERN.test(routingMessage)
  ) return "DRAFT_CUSTOMER";
  if (QUOTE_SEND_INTENT_PATTERN.test(routingMessage)) return "PREPARE_QUOTE_SEND";
  const lower = routingMessage.toLowerCase();
  // Catalog lookup is deterministic and should not inherit a stale customer
  // search selection. Quote drafting and financial wording retain precedence.
  if (
    PRODUCT_SEARCH_INTENT_PATTERN.test(routingMessage)
    && !QUOTE_DRAFT_INTENT_PATTERN.test(lower)
    && !FINANCIAL_INTENT_PATTERN.test(lower)
  ) return "SEARCH_PRODUCTS";
  if (requestedTool && requestedTool !== "AUTO") {
    if (ASSISTANT_HELP_PATTERN.test(routingMessage)) return "ASSISTANT_HELP";
    const hasQuoteFlyIntent =
      PIPELINE_SCENARIO_PATTERN.test(lower)
      || PREPARE_ACTIVITY_INTENT_PATTERN.test(lower)
      || PREPARE_DISPATCH_INTENT_PATTERN.test(lower)
      || PREPARE_BOOKING_INTENT_PATTERN.test(lower)
      || LIST_SCHEDULE_INTENT_PATTERN.test(lower)
      || INVOICE_STATUS_INTENT_PATTERN.test(lower)
      || INVOICE_LIST_INTENT_PATTERN.test(lower)
      || JOB_STATUS_INTENT_PATTERN.test(lower)
      || JOB_SEARCH_INTENT_PATTERN.test(lower)
      || PRIORITIZE_MY_DAY_PATTERN.test(lower)
      || ACTIVITY_TASK_INTENT_PATTERN.test(lower)
      || CUSTOMERS_WITHOUT_QUOTES_PATTERN.test(lower)
      || FOLLOW_UP_INTENT_PATTERN.test(lower)
      || Boolean(navigationTarget(lower))
      || FINANCIAL_INTENT_PATTERN.test(lower)
      || PRODUCT_SEARCH_INTENT_PATTERN.test(routingMessage)
      || PIPELINE_INTENT_PATTERN.test(lower)
      || CUSTOMER_DRAFT_INTENT_PATTERN.test(lower)
      || CUSTOMER_INTENT_PATTERN.test(lower)
      || QUOTE_SEND_INTENT_PATTERN.test(lower)
      || QUOTE_DRAFT_INTENT_PATTERN.test(lower)
      || CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage);
    return hasQuoteFlyIntent ? requestedTool : "OUT_OF_SCOPE";
  }

  if (PIPELINE_SCENARIO_PATTERN.test(lower)) return "PIPELINE_SCENARIO";
  if (PREPARE_ACTIVITY_INTENT_PATTERN.test(lower)) return "PREPARE_ACTIVITY";
  if (PREPARE_DISPATCH_INTENT_PATTERN.test(lower)) return "PREPARE_DISPATCH";
  if (PREPARE_BOOKING_INTENT_PATTERN.test(lower)) return "PREPARE_BOOKING";
  if (LIST_SCHEDULE_INTENT_PATTERN.test(lower)) return "LIST_SCHEDULE";
  if (INVOICE_STATUS_INTENT_PATTERN.test(lower)) return "GET_INVOICE_STATUS";
  if (INVOICE_LIST_INTENT_PATTERN.test(lower)) return "LIST_INVOICES";
  if (JOB_STATUS_INTENT_PATTERN.test(lower)) return "GET_JOB_STATUS";
  if (JOB_SEARCH_INTENT_PATTERN.test(lower)) return "SEARCH_JOBS";
  if (PRIORITIZE_MY_DAY_PATTERN.test(lower)) return "PRIORITIZE_MY_DAY";
  if (ACTIVITY_TASK_INTENT_PATTERN.test(lower)) return "LIST_MY_ACTIVITIES";
  if (CUSTOMERS_WITHOUT_QUOTES_PATTERN.test(lower)) return "CUSTOMERS_WITHOUT_QUOTES";
  if (FOLLOW_UP_INTENT_PATTERN.test(lower)) return "FOLLOW_UP_QUEUE";
  if (navigationTarget(lower)) return "NAVIGATE_WORKSPACE";
  if (FINANCIAL_INTENT_PATTERN.test(lower)) return "RANK_PROFITABLE_JOBS";
  if (PIPELINE_INTENT_PATTERN.test(lower)) return "SUMMARIZE_PIPELINE";
  if (QUOTE_DRAFT_INTENT_PATTERN.test(lower)) return "DRAFT_QUOTE";

  if (previousTool === "DRAFT_QUOTE" && CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage)) {
    return "DRAFT_QUOTE";
  }
  if (previousTool === "DRAFT_CUSTOMER" && CUSTOMER_DRAFT_DETAIL_PATTERN.test(routingMessage)) {
    return "DRAFT_CUSTOMER";
  }
  if (previousTool === "PREPARE_QUOTE_SEND" && QUOTE_SEND_FOLLOW_UP_PATTERN.test(lower.trim())) {
    return "PREPARE_QUOTE_SEND";
  }
  if (CUSTOMER_INTENT_PATTERN.test(lower)) return "SEARCH_CUSTOMERS";
  if (previousTool && previousTool !== "NAVIGATE_WORKSPACE" && CONVERSATION_FOLLOW_UP_PATTERN.test(lower.trim())) {
    return previousTool;
  }

  if (ASSISTANT_HELP_PATTERN.test(routingMessage)) return "ASSISTANT_HELP";

  if (CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage)) {
    if (context?.currentPage === "customers") return "SEARCH_CUSTOMERS";
    if (context?.currentPage === "quotes") return "DRAFT_QUOTE";
    if (context?.currentPage === "analytics") return "SUMMARIZE_PIPELINE";
    if (context?.currentPage === "jobs") {
      if (context.invoiceId) return "GET_INVOICE_STATUS";
      if (context.jobId) return "GET_JOB_STATUS";
      return "SEARCH_JOBS";
    }
  }

  return "OUT_OF_SCOPE";
}

export function inferAssistantRelativeDateRange(message: string, now: Date) {
  const normalized = normalizeAssistantRoutingText(message).toLowerCase();
  const numericDays = normalized.match(/\b(?:last|past|previous|ultimos?|pasados?|anteriores?)\s+(\d{1,3})\s+(?:days?|dias?)\b/);
  let days = numericDays ? Number(numericDays[1]) : null;
  if (days === null && /\b(?:last|past|previous)\s+week\b|\b(?:(?:ultima|pasada|anterior)\s+semana|semana\s+(?:ultima|pasada|anterior))\b/.test(normalized)) days = 7;
  if (days === null && /\b(?:last|past|previous)\s+month\b|\b(?:(?:ultimo|pasado|anterior)\s+mes|mes\s+(?:ultimo|pasado|anterior))\b/.test(normalized)) days = 30;
  if (days === null && /\b(?:last|past|previous)\s+quarter\b|\b(?:(?:ultimo|pasado|anterior)\s+trimestre|trimestre\s+(?:ultimo|pasado|anterior))\b/.test(normalized)) days = 90;
  if (days === null && /\b(?:last|past|previous)\s+year\b|\b(?:(?:ultimo|pasado|anterior)\s+ano|ano\s+(?:ultimo|pasado|anterior))\b/.test(normalized)) days = 365;
  if (days === null || !Number.isFinite(days) || days < 1 || days > 730) return null;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days);
  return { from, to: now };
}

export function assistantToolConsumesAiBudget(tool: AiAssistantTool) {
  return ![
    "NAVIGATE_WORKSPACE",
    "LIST_MY_ACTIVITIES",
    "PRIORITIZE_MY_DAY",
    "FOLLOW_UP_QUEUE",
    "CUSTOMERS_WITHOUT_QUOTES",
    "PIPELINE_SCENARIO",
    "DRAFT_CUSTOMER",
    "DRAFT_PRODUCT",
    "PREPARE_ACTIVITY",
    "LIST_SCHEDULE",
    "SEARCH_JOBS",
    "GET_JOB_STATUS",
    "LIST_INVOICES",
    "GET_INVOICE_STATUS",
    "PREPARE_BOOKING",
    "PREPARE_DISPATCH",
    "SEARCH_PRODUCTS",
    "PREPARE_QUOTE_SEND",
    "ASSISTANT_HELP",
    "OUT_OF_SCOPE",
  ].includes(tool);
}

export function assistantRequestConsumesAiBudget(
  message: string,
  requestedTool?: AiAssistantRequestedTool,
  context?: AiAssistantContext,
  conversation?: readonly AiAssistantConversationTurn[],
) {
  return assistantToolConsumesAiBudget(resolveAssistantTool(message, requestedTool, context, conversation));
}

function defaultExcludedFields(financial = false) {
  return [
    "tenant ids",
    "deleted rows",
    "provider identifiers",
    "raw prompts",
    ...(financial ? [] : ["internal costs", "gross profit", "margins"]),
  ];
}

function currency(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function money(value: number, locale: SupportedLocale = "en-US") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function localizedJobStatus(params: AiAssistantInput, status: string) {
  const english: Record<string, string> = {
    UNSCHEDULED: "unscheduled", SCHEDULED: "scheduled", DISPATCHED: "dispatched",
    IN_PROGRESS: "in progress", COMPLETED: "completed", CANCELED: "canceled",
  };
  const spanish: Record<string, string> = {
    UNSCHEDULED: "sin programar", SCHEDULED: "programado", DISPATCHED: "despachado",
    IN_PROGRESS: "en proceso", COMPLETED: "completado", CANCELED: "cancelado",
  };
  return (isSpanishAssistant(params) ? spanish : english)[status] ?? status.toLowerCase().replaceAll("_", " ");
}

function localizedInvoiceStatus(params: AiAssistantInput, status: string) {
  const english: Record<string, string> = {
    DRAFT: "draft", OPEN: "open", PAID: "paid", VOID: "void", UNCOLLECTIBLE: "uncollectible",
  };
  const spanish: Record<string, string> = {
    DRAFT: "en borrador", OPEN: "abierta", PAID: "pagada", VOID: "anulada", UNCOLLECTIBLE: "incobrable",
  };
  return (isSpanishAssistant(params) ? spanish : english)[status] ?? status.toLowerCase().replaceAll("_", " ");
}

function localizedInvoicePaymentStatus(params: AiAssistantInput, status: string) {
  const english: Record<string, string> = {
    PENDING: "pending", SUCCEEDED: "paid", FAILED: "failed", REFUNDED: "refunded",
    PARTIALLY_REFUNDED: "partially refunded", CANCELED: "canceled",
  };
  const spanish: Record<string, string> = {
    PENDING: "pendiente", SUCCEEDED: "pagado", FAILED: "fallido", REFUNDED: "reembolsado",
    PARTIALLY_REFUNDED: "parcialmente reembolsado", CANCELED: "cancelado",
  };
  return (isSpanishAssistant(params) ? spanish : english)[status] ?? status.toLowerCase().replaceAll("_", " ");
}

function requestedTool(params: AiAssistantInput): AiAssistantRequestedTool {
  return params.tool ?? "AUTO";
}

function diagnostics(params: {
  input: AiAssistantInput;
  resolvedTool: AiAssistantTool;
  resultCount: number;
  citationCount: number;
  emptyReason?: string | null;
  archivePolicy: string;
  filters?: Record<string, string | number | boolean | null | undefined>;
}): AiAssistantDiagnostics {
  const filters = Object.fromEntries(
    Object.entries(params.filters ?? {}).map(([key, value]) => [key, value ?? null]),
  ) as Record<string, string | number | boolean | null>;

  return {
    requestedTool: requestedTool(params.input),
    resolvedTool: params.resolvedTool,
    resultCount: params.resultCount,
    citationCount: params.citationCount,
    emptyReason: params.emptyReason ?? null,
    archivePolicy: params.archivePolicy,
    filters,
    answerMode: "DETERMINISTIC",
    model: null,
  };
}

function composedDiagnostics(
  base: AiAssistantDiagnostics,
  composition: AiAssistantCompositionResult,
): AiAssistantDiagnostics {
  return {
    ...base,
    answerMode: composition.answerMode,
    model: composition.model,
  };
}

async function createAssistantUsageEvent(
  prisma: PrismaClient,
  params: {
    access: AccessContext;
    actor: ActivityActor;
    message: string;
    answer: string;
    classification: DataClassification;
    sourceTypes: string[];
    sourceLabels: string[];
    quoteId?: string | null;
    customerId?: string | null;
    serviceType?: ServiceCategory | null;
    creditsConsumed?: number;
    riskNote?: string;
    auditSummary?: string;
    confidenceLevel?: string;
    confidenceLabel?: string;
    insightReasons?: string[];
    retrievalAuditEventId?: string | null;
    model?: string | null;
    telemetry?: AiUsageTelemetry | null;
    eventType?: AiUsageEventType;
    purpose?: AiPurpose;
  },
) {
  return createAiUsageEvent(prisma, {
    tenantId: params.access.tenantId,
    quoteId: params.quoteId ?? null,
    customerId: params.customerId ?? null,
    actor: params.actor,
    eventType: params.eventType ?? "BUSINESS_INSIGHT",
    purpose: params.purpose ?? "BUSINESS_INSIGHT",
    classification: params.classification,
    promptText: params.message,
    requestId: params.access.requestId,
    serviceType: params.serviceType ?? null,
    creditsConsumed: params.creditsConsumed ?? 1,
    model: params.model ?? null,
    telemetry: params.telemetry ?? null,
    sensitiveValues: [params.message],
    retrievalAuditEventId: params.retrievalAuditEventId ?? null,
    trace: {
      insightSummary: params.auditSummary ?? params.answer,
      insightReasons: [
        "assistant tool registry execution",
        `toolClassification=${params.classification}`,
        ...(params.insightReasons ?? []),
      ],
      insightSourceLabels: params.sourceLabels,
      sourceTypes: params.sourceTypes,
      confidenceLevel: params.confidenceLevel ?? "high",
      confidenceLabel: params.confidenceLabel ?? "Deterministic approved tool",
      riskNote: params.riskNote ?? "Tenant-scoped assistant response generated without exposing raw prompts.",
    },
  });
}

async function runNonDataAssistantResponse(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "ASSISTANT_HELP" | "OUT_OF_SCOPE",
): Promise<AiAssistantRunResult> {
  const isOutOfScope = tool === "OUT_OF_SCOPE";
  const answer = isOutOfScope
    ? localeText(
        params,
        "I can only help with work inside QuoteFly—customers, quotes, products, follow-ups, pipeline, profitability, and workspace navigation. Try asking, “Which customers need follow-up?” or “Draft a quote for a roof repair.”",
        "Solo puedo ayudarte con el trabajo dentro de QuoteFly: clientes, cotizaciones, productos, seguimientos, pipeline, rentabilidad y navegación. Prueba: “¿Qué clientes necesitan seguimiento?” o “Prepara una cotización para reparar un techo”.",
      )
    : localeText(
        params,
        "I can find customers, draft quotes and products, check follow-ups, summarize pipeline revenue, rank job profitability when your role allows it, and move you around QuoteFly. Tell me what you’re trying to get done.",
        "Puedo buscar clientes, preparar cotizaciones y productos, revisar seguimientos, resumir ingresos del pipeline, ordenar trabajos por rentabilidad cuando tu rol lo permite y llevarte a la sección correcta de QuoteFly. Dime qué necesitas hacer.",
      );
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C1_BUSINESS_INTERNAL",
    sourceTypes: ["QuoteFlyAssistant"],
    sourceLabels: [isOutOfScope ? "QuoteFly scope guard" : "Kody capability guide"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic QuoteFly scope policy",
    insightReasons: [isOutOfScope ? "request rejected by deterministic scope guard" : "capability help handled without retrieval"],
    riskNote: isOutOfScope
      ? "No model call or workspace retrieval was performed for the out-of-scope request."
      : "Capability help was generated without a model call or workspace retrieval.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C1_BUSINESS_INTERNAL",
      answer,
      results: [],
      citations: [],
      actions: [],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: 0,
        citationCount: 0,
        emptyReason: isOutOfScope
          ? "The request is outside Kody's QuoteFly-only scope."
          : "Capability help does not retrieve workspace records.",
        archivePolicy: isOutOfScope
          ? "Out-of-scope requests do not retrieve workspace records or call the language model."
          : "Capability help does not retrieve workspace records.",
        filters: {
          scopeDecision: tool,
          modelCalled: false,
          workspaceRowsRetrieved: false,
        },
      }),
    },
  };
}

async function runCustomerSearch(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    const answer = localeText(
      params,
      "Customer lookup requires permission to view customer contact data.",
      "La búsqueda de clientes requiere permiso para ver sus datos de contacto.",
    );
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Customer"],
      sourceLabels: ["Customer lookup denied"],
      creditsConsumed: 0,
      riskNote: "Denied before customer PII retrieval because the actor lacks viewCustomerPii.",
    });

    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "SEARCH_CUSTOMERS",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: localeText(params, "Ask an admin for customer access", "Solicitar acceso a clientes"), requiresConfirmation: true, payload: { capability: "viewCustomerPii" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "SEARCH_CUSTOMERS",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Customer lookup denied before retrieval because the role lacks customer PII access.",
          archivePolicy: "No customer rows are retrieved when customer PII access is denied.",
          filters: {
            includeArchivedRequested: Boolean(params.context?.includeArchived),
            includeArchivedEffective: false,
            limit: clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT),
          },
        }),
      },
    };
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const scopedCustomerId = params.context?.customerId?.trim();
  const search = cleanSearchQuery(params.message, params.context?.search);
  const phoneDigits = normalizePhoneSearchDigits(search);
  const tokens = searchableTokens(search);
  const filters: Prisma.CustomerWhereInput[] = [];
  if (search.length >= 2) {
    filters.push(
      { fullName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    );
  }
  for (const token of tokens) {
    filters.push(
      { fullName: { contains: token, mode: "insensitive" } },
      { email: { contains: token, mode: "insensitive" } },
    );
  }
  if (phoneDigits && phoneDigits.length >= 3) {
    filters.push({ phoneDigits: { contains: phoneDigits } });
  }

  const customers = await prisma.customer.findMany({
    where: {
      ...tenantActiveCustomerScope(params.access.tenantId),
      ...assignedCustomerScope(params.access),
      ...(scopedCustomerId ? { id: scopedCustomerId } : filters.length ? { OR: filters } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      followUpStatus: true,
      updatedAt: true,
      _count: {
        select: {
          quotes: {
            where: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) },
          },
        },
      },
      quotes: {
        where: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          title: true,
          status: true,
          totalAmount: true,
          updatedAt: true,
        },
      },
    },
  });

  const answer = customers.length
    ? localeText(
        params,
        `Found ${customers.length} active customer${customers.length === 1 ? "" : "s"} matching "${search || "recent customers"}".`,
        `Encontré ${customers.length} cliente${customers.length === 1 ? " activo" : "s activos"} que coincide${customers.length === 1 ? "" : "n"} con “${search || "clientes recientes"}”.`,
      )
    : localeText(
        params,
        `I did not find active customers matching "${search}".`,
        `No encontré clientes activos que coincidan con “${search}”.`,
      );
  const includeArchivedRequested = Boolean(params.context?.includeArchived);
  const results = customers.map((customer) => {
    const latestQuote = customer.quotes[0] ?? null;
    return {
      customerId: customer.id,
      fullName: customer.fullName,
      email: customer.email ?? null,
      phone: customer.phone,
      followUpStatus: customer.followUpStatus,
      quoteCount: customer._count.quotes,
      latestQuoteTitle: latestQuote?.title ?? null,
      latestQuoteStatus: latestQuote?.status ?? null,
      latestQuoteTotalAmount: currency(latestQuote?.totalAmount) ?? null,
      latestQuoteUpdatedAtUtc: latestQuote?.updatedAt.toISOString() ?? null,
    };
  });
  const citations: AiAssistantCitation[] = [{ key: "A1", label: localeText(params, "Active tenant customer lookup", "Búsqueda de clientes activos del espacio de trabajo"), sourceType: "Customer", classification: "C2_CUSTOMER_CONFIDENTIAL" }];
  const actions = customers.map((customer) => ({
    type: "OPEN_CUSTOMER" as const,
    label: localeText(params, `Open ${customer.fullName}`, `Abrir a ${customer.fullName}`),
    requiresConfirmation: false,
    payload: { customerId: customer.id },
  }));
  const fieldsExcluded = [
    ...defaultExcludedFields(false),
    "archived customers",
    "deleted customers",
    ...(includeArchivedRequested ? ["includeArchived ignored for customer lookup"] : []),
  ];
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "SEARCH_CUSTOMERS",
    resultCount: customers.length,
    citationCount: citations.length,
    emptyReason: customers.length ? null : "No active customer rows matched tenant scope and search filters.",
    archivePolicy: "Customer lookup searches active customers only; archived/deleted customers are excluded.",
    filters: {
      currentPage: params.context?.currentPage,
      searchProvided: Boolean(search),
      searchTokenCount: tokens.length,
      phoneSearchUsed: Boolean(phoneDigits && phoneDigits.length >= 3),
      scopedCustomer: Boolean(scopedCustomerId),
      limit,
      includeArchivedRequested,
      includeArchivedEffective: false,
    },
  });
  const composition = await composeAssistantAnswer({
    diagnosticContext: { requestId: params.access.requestId },
    userMessage: params.message,
    tool: "SEARCH_CUSTOMERS",
    deterministicAnswer: answer,
    maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
    results,
    citations,
    actions,
    fieldsExcluded,
    diagnostics: baseDiagnostics,
    sensitiveValues: [params.actor.actorEmail, params.actor.actorName],
    conversation: params.conversation,
    preferredLocale: assistantLocale(params),
  });
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer: composition.answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: ["Active tenant customer lookup"],
    customerId: customers[0]?.id ?? null,
    model: composition.model,
    telemetry: composition.telemetry,
    confidenceLevel: composition.confidenceLevel,
    confidenceLabel: composition.confidenceLabel,
    insightReasons: composition.insightReasons,
    riskNote: composition.riskNote,
  });

  return {
    consumedCredits: 1,
    consumedSpendUsd: composition.telemetry?.estimatedCostUsd ?? 0,
    assistant: {
      tool: "SEARCH_CUSTOMERS",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer: composition.answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: composedDiagnostics(baseDiagnostics, composition),
    },
  };
}

async function runProductSearch(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const canViewInternalCosts = hasCapability(params.access, "viewInternalCosts");
  const limit = clampLimit(params.context?.limit, MAX_PRODUCT_LIMIT, DEFAULT_PRODUCT_LIMIT);
  const search = cleanProductSearchQuery(params.message, params.context?.search);
  const tokens = searchableTokens(search).filter((token) => ![
    "product",
    "products",
    "service",
    "services",
    "catalog",
    "item",
    "items",
  ].includes(token));
  const filters: Prisma.WorkPresetWhereInput[] = [];
  if (search.length >= 2) {
    filters.push(
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    );
  }
  for (const token of tokens) {
    filters.push(
      { name: { contains: token, mode: "insensitive" } },
      { description: { contains: token, mode: "insensitive" } },
    );
  }

  const products = await prisma.workPreset.findMany({
    where: {
      tenantId: params.access.tenantId,
      deletedAtUtc: null,
      ...(params.context?.serviceType ? { serviceType: params.context.serviceType } : {}),
      ...(filters.length ? { OR: filters } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      description: true,
      serviceType: true,
      category: true,
      unitType: true,
      defaultQuantity: true,
      unitCost: canViewInternalCosts,
      unitPrice: true,
    },
  });

  const results = products.map((product) => ({
    productId: product.id,
    name: product.name,
    unitPrice: currency(product.unitPrice) ?? 0,
    ...(canViewInternalCosts ? { unitCost: currency(product.unitCost) ?? 0 } : {}),
    serviceType: product.serviceType,
    category: product.category,
    unitType: product.unitType,
    defaultQuantity: currency(product.defaultQuantity) ?? 1,
    description: product.description ?? null,
  }));
  const answer = products.length
    ? localeText(
        params,
        `Found ${products.length} active product${products.length === 1 ? "" : "s"}${search ? ` matching \"${search}\"` : " in your catalog"}.`,
        `Encontré ${products.length} producto${products.length === 1 ? " activo" : "s activos"}${search ? ` que coincide${products.length === 1 ? "" : "n"} con “${search}”` : " en tu catálogo"}.`,
      )
    : localeText(
        params,
        `I did not find active products${search ? ` matching \"${search}\"` : ""}.`,
        `No encontré productos activos${search ? ` que coincidan con “${search}”` : ""}.`,
      );
  const maxClassification: DataClassification = canViewInternalCosts
    ? "C3_FINANCIAL_CONFIDENTIAL"
    : "C2_CUSTOMER_CONFIDENTIAL";
  const catalogManaged = hasCapability(params.access, "manageCatalog");
  const action: AiAssistantAction = catalogManaged
    ? {
      type: "OPEN_WORKSPACE_PAGE",
      label: localeText(params, "Open products", "Abrir productos"),
      requiresConfirmation: false,
      payload: { page: "products" },
    }
    : {
      type: "OPEN_WORKSPACE_PAGE",
      label: localeText(params, "Use on a quote", "Usar en una cotización"),
      requiresConfirmation: false,
      payload: { page: "build" },
    };
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Active tenant product catalog", "Catálogo activo del espacio de trabajo"),
    sourceType: "WorkPreset",
    classification: maxClassification,
  }];
  const fieldsExcluded = [
    ...defaultExcludedFields(canViewInternalCosts),
    "archived products",
    "deleted products",
  ];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: maxClassification,
    sourceTypes: ["WorkPreset"],
    sourceLabels: ["Active tenant product lookup"],
    serviceType: params.context?.serviceType ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic tenant product lookup",
    riskNote: "Only active, tenant-scoped catalog records were read. Internal cost is omitted unless the signed-in role has viewInternalCosts.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "SEARCH_PRODUCTS",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification,
      answer,
      results,
      citations,
      actions: [action],
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "SEARCH_PRODUCTS",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active tenant product rows matched the bounded search filters.",
        archivePolicy: "Product lookup searches active tenant catalog records only; archived/deleted products are excluded.",
        filters: {
          currentPage: params.context?.currentPage,
          searchProvided: Boolean(search),
          searchTokenCount: tokens.length,
          serviceType: params.context?.serviceType ?? null,
          limit,
          internalCostVisible: canViewInternalCosts,
          catalogManaged,
        },
      }),
    },
  };
}

const OPERATIONAL_SEARCH_STOP_WORDS = new Set([
  "job", "jobs", "work", "order", "orders", "trabajo", "trabajos", "obra", "obras",
  "invoice", "invoices", "bill", "bills", "factura", "facturas", "cobro", "cobros",
  "status", "state", "progress", "payment", "paid", "balance", "due", "overdue",
  "estado", "progreso", "pago", "pagada", "saldo", "vence", "vencida",
  "find", "search", "lookup", "show", "list", "open", "buscar", "busca", "mostrar", "muestra", "listar", "lista",
  "my", "me", "mine", "the", "a", "an", "mi", "mis", "mio", "mia", "mios", "mias", "el", "la", "los", "las",
]);

function operationalSearchTokens(message: string, contextSearch?: string) {
  return searchableTokens(contextSearch?.trim() || message)
    .filter((token) => !OPERATIONAL_SEARCH_STOP_WORDS.has(token))
    .slice(0, 4);
}

function extractOperationalNumber(message: string, kind: "job" | "invoice") {
  const pattern = kind === "job"
    ? /\b(?:job|work\s+order|trabajo|obra)\s*(?:number|no\.?|#|numero)?\s*[#-]?\s*(\d{1,9})\b/i
    : /\b(?:invoice|bill|factura|cobro)\s*(?:number|no\.?|#|numero)?\s*[#-]?\s*(\d{1,9})\b/i;
  const matched = message.match(pattern)?.[1];
  const parsed = matched ? Number.parseInt(matched, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function runJobLookup(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "SEARCH_JOBS" | "GET_JOB_STATUS",
): Promise<AiAssistantRunResult> {
  const limit = tool === "GET_JOB_STATUS"
    ? 1
    : clampLimit(params.context?.limit, MAX_OPERATIONAL_RECORD_LIMIT, DEFAULT_OPERATIONAL_RECORD_LIMIT);
  const jobId = params.context?.jobId?.trim();
  const jobNumber = extractOperationalNumber(params.message, "job");
  const tokens = operationalSearchTokens(params.message, params.context?.search);
  const searchFilters: Prisma.JobWhereInput[] = [];
  for (const token of tokens) {
    searchFilters.push(
      { title: { contains: token, mode: "insensitive" } },
      { customer: { fullName: { contains: token, mode: "insensitive" } } },
      { sourceQuote: { title: { contains: token, mode: "insensitive" } } },
    );
  }

  const jobRows = await withTenantRlsContext(prisma, params.access.tenantId, (transaction) => transaction.job.findMany({
    where: {
      ...visibleJobWhere(params.access),
      ...(jobId
        ? { id: jobId }
        : jobNumber
          ? { jobNumber }
          : searchFilters.length
            ? { OR: searchFilters }
            : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      jobNumber: true,
      status: true,
      title: true,
      serviceType: true,
      updatedAt: true,
      customer: { select: { id: true, fullName: true } },
      assignedTenantUser: {
        select: { id: true, user: { select: { fullName: true } } },
      },
      appointments: {
        where: { deletedAtUtc: null },
        orderBy: [{ startsAtUtc: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          status: true,
          startsAtUtc: true,
          endsAtUtc: true,
          timeZone: true,
        },
      },
    },
  }));

  const jobsTruncated = jobRows.length > limit;
  const jobs = jobRows.slice(0, limit);
  const results = jobs.map((job) => {
    const appointment = job.appointments[0] ?? null;
    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      status: job.status,
      title: job.title,
      serviceType: job.serviceType,
      customerId: job.customer.id,
      customerName: job.customer.fullName,
      assignedTenantUserId: job.assignedTenantUser?.id ?? null,
      assignedTo: job.assignedTenantUser?.user.fullName ?? null,
      appointmentId: appointment?.id ?? null,
      appointmentStatus: appointment?.status ?? null,
      startsAtUtc: appointment?.startsAtUtc.toISOString() ?? null,
      endsAtUtc: appointment?.endsAtUtc.toISOString() ?? null,
      appointmentTimeZone: appointment?.timeZone ?? null,
      updatedAtUtc: job.updatedAt.toISOString(),
    };
  });
  const answer = jobs.length
    ? localeText(
        params,
        tool === "GET_JOB_STATUS"
          ? `Job #${jobs[0]!.jobNumber} is ${localizedJobStatus(params, jobs[0]!.status)}.`
          : jobsTruncated
            ? `Showing the first ${jobs.length} active jobs you can access. More matches exist; narrow the customer, job number, or title to find a specific job.`
            : `Found ${jobs.length} active job${jobs.length === 1 ? "" : "s"} you can access.`,
        tool === "GET_JOB_STATUS"
          ? `El trabajo #${jobs[0]!.jobNumber} está ${localizedJobStatus(params, jobs[0]!.status)}.`
          : jobsTruncated
            ? `Muestro los primeros ${jobs.length} trabajos activos a los que tienes acceso. Hay más coincidencias; limita la búsqueda por cliente, número o título.`
            : `Encontré ${jobs.length} trabajo${jobs.length === 1 ? " activo" : "s activos"} a los que tienes acceso.`,
      )
    : localeText(
        params,
        "I did not find an active job you can access matching that request.",
        "No encontré un trabajo activo al que tengas acceso que coincida con esa solicitud.",
      );
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Authorized tenant job records", "Registros de trabajo autorizados del espacio de trabajo"),
    sourceType: "Job",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const actions: AiAssistantAction[] = jobs.map((job) => ({
    type: "OPEN_WORKSPACE_PAGE",
    label: localeText(params, `Open job #${job.jobNumber}`, `Abrir trabajo #${job.jobNumber}`),
    requiresConfirmation: false,
    payload: { page: "jobs", jobId: job.id, jobNumber: job.jobNumber },
  }));
  const fieldsExcluded = [
    ...defaultExcludedFields(false),
    "job scope and access instructions",
    "job notes",
    "archived jobs",
    "deleted jobs",
    ...(params.context?.includeArchived ? ["includeArchived ignored for job lookup"] : []),
  ];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Job", "JobAppointment", "Customer"],
    sourceLabels: ["Authorized tenant job lookup"],
    customerId: jobs[0]?.customer.id ?? null,
    serviceType: jobs[0]?.serviceType ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic authorized job lookup",
    riskNote: "Job rows are tenant, live-assignment, and lifecycle scoped. Job notes, scope, addresses, and access instructions are not returned.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active job matched the authorized tenant and assignment scope.",
        archivePolicy: "Job lookup excludes archived/deleted jobs and inaccessible assignments.",
        filters: {
          scopedJob: Boolean(jobId),
          jobNumber,
          searchTokenCount: tokens.length,
          limit,
          includeArchivedRequested: Boolean(params.context?.includeArchived),
          includeArchivedEffective: false,
          resultsTruncated: jobsTruncated,
        },
      }),
    },
  };
}

async function runInvoiceLookup(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "LIST_INVOICES" | "GET_INVOICE_STATUS",
): Promise<AiAssistantRunResult> {
  const canViewBalances = hasCapability(params.access, "viewBilling");
  const limit = tool === "GET_INVOICE_STATUS"
    ? 1
    : clampLimit(params.context?.limit, MAX_OPERATIONAL_RECORD_LIMIT, DEFAULT_OPERATIONAL_RECORD_LIMIT);
  const invoiceId = params.context?.invoiceId?.trim();
  const invoiceNumber = extractOperationalNumber(params.message, "invoice");
  const tokens = operationalSearchTokens(params.message, params.context?.search);
  const searchFilters: Prisma.InvoiceWhereInput[] = [];
  for (const token of tokens) {
    searchFilters.push(
      { titleSnapshot: { contains: token, mode: "insensitive" } },
      { customer: { fullName: { contains: token, mode: "insensitive" } } },
      { job: { title: { contains: token, mode: "insensitive" } } },
    );
  }

  const invoiceRows = await withTenantRlsContext(prisma, params.access.tenantId, (transaction) => transaction.invoice.findMany({
    where: {
      tenantId: params.access.tenantId,
      archivedAtUtc: null,
      deletedAtUtc: null,
      job: visibleJobWhere(params.access),
      ...(invoiceId
        ? { id: invoiceId }
        : invoiceNumber
          ? { invoiceNumber }
          : searchFilters.length
            ? { OR: searchFilters }
            : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      paymentStatus: true,
      titleSnapshot: true,
      totalAmount: canViewBalances,
      amountPaid: canViewBalances,
      balanceDue: canViewBalances,
      dueAtUtc: true,
      updatedAt: true,
      customer: { select: { id: true, fullName: true } },
      job: { select: { id: true, jobNumber: true, title: true } },
    },
  }));

  const invoicesTruncated = invoiceRows.length > limit;
  const invoices = invoiceRows.slice(0, limit);
  const results = invoices.map((invoice) => ({
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    paymentStatus: invoice.paymentStatus,
    title: invoice.titleSnapshot,
    customerId: invoice.customer.id,
    customerName: invoice.customer.fullName,
    jobId: invoice.job.id,
    jobNumber: invoice.job.jobNumber,
    jobTitle: invoice.job.title,
    dueAtUtc: invoice.dueAtUtc?.toISOString() ?? null,
    updatedAtUtc: invoice.updatedAt.toISOString(),
    ...(canViewBalances
      ? {
        totalAmount: currency(invoice.totalAmount) ?? 0,
        amountPaid: currency(invoice.amountPaid) ?? 0,
        balanceDue: currency(invoice.balanceDue) ?? 0,
      }
      : {}),
  }));
  const answer = invoices.length
    ? localeText(
        params,
        tool === "GET_INVOICE_STATUS"
          ? `Invoice #${invoices[0]!.invoiceNumber} is ${localizedInvoiceStatus(params, invoices[0]!.status)} with payment ${localizedInvoicePaymentStatus(params, invoices[0]!.paymentStatus)}.`
          : invoicesTruncated
            ? `Showing the first ${invoices.length} active invoices you can access. More matches exist; narrow the customer, invoice number, or title to find a specific invoice.`
            : `Found ${invoices.length} active invoice${invoices.length === 1 ? "" : "s"} you can access.`,
        tool === "GET_INVOICE_STATUS"
          ? `La factura #${invoices[0]!.invoiceNumber} está ${localizedInvoiceStatus(params, invoices[0]!.status)} con pago ${localizedInvoicePaymentStatus(params, invoices[0]!.paymentStatus)}.`
          : invoicesTruncated
            ? `Muestro las primeras ${invoices.length} facturas activas a las que tienes acceso. Hay más coincidencias; limita la búsqueda por cliente, número o título.`
            : `Encontré ${invoices.length} factura${invoices.length === 1 ? " activa" : "s activas"} a las que tienes acceso.`,
      )
    : localeText(
        params,
        "I did not find an active invoice you can access matching that request.",
        "No encontré una factura activa a la que tengas acceso que coincida con esa solicitud.",
      );
  const classification: DataClassification = canViewBalances
    ? "C3_FINANCIAL_CONFIDENTIAL"
    : "C2_CUSTOMER_CONFIDENTIAL";
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Authorized tenant invoice records", "Registros de factura autorizados del espacio de trabajo"),
    sourceType: "Invoice",
    classification,
  }];
  const actions: AiAssistantAction[] = invoices.map((invoice) => ({
    type: "OPEN_WORKSPACE_PAGE",
    label: localeText(params, `Open invoice #${invoice.invoiceNumber}`, `Abrir factura #${invoice.invoiceNumber}`),
    requiresConfirmation: false,
    payload: {
      page: "jobs",
      jobId: invoice.job.id,
      jobNumber: invoice.job.jobNumber,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
    },
  }));
  const fieldsExcluded = [
    ...defaultExcludedFields(canViewBalances),
    "invoice payment provider identifiers",
    "invoice event history",
    "archived invoices",
    "deleted invoices",
    ...(canViewBalances ? [] : ["invoice totals", "amount paid", "balance due"]),
    ...(params.context?.includeArchived ? ["includeArchived ignored for invoice lookup"] : []),
  ];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification,
    sourceTypes: ["Invoice", "Job", "Customer"],
    sourceLabels: ["Authorized tenant invoice lookup"],
    customerId: invoices[0]?.customer.id ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic authorized invoice lookup",
    riskNote: canViewBalances
      ? "Invoice rows are tenant, job-assignment, and lifecycle scoped; balances are included because the live role can view billing."
      : "Invoice rows are tenant, job-assignment, and lifecycle scoped; all monetary balances are omitted for this live role.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: classification,
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active invoice matched the authorized tenant and job-assignment scope.",
        archivePolicy: "Invoice lookup excludes archived/deleted invoices and invoices linked to inaccessible jobs.",
        filters: {
          scopedInvoice: Boolean(invoiceId),
          invoiceNumber,
          searchTokenCount: tokens.length,
          limit,
          balancesVisible: canViewBalances,
          includeArchivedRequested: Boolean(params.context?.includeArchived),
          includeArchivedEffective: false,
          resultsTruncated: invoicesTruncated,
        },
      }),
    },
  };
}

function workspacePageLabel(page: AiWorkspaceTarget, locale: SupportedLocale = "en-US") {
  if (locale === "es-US") {
    if (page === "follow-up") return "Seguimiento";
    if (page === "build") return "Nueva cotización";
    if (page === "customers") return "Clientes";
    if (page === "quotes") return "Cotizaciones";
    if (page === "products") return "Productos";
    return "Análisis";
  }
  if (page === "follow-up") return "Follow-up";
  if (page === "build") return "New quote";
  return `${page.charAt(0).toUpperCase()}${page.slice(1)}`;
}

type ProductDraft = Readonly<{
  name: string;
  description: string;
  category: "LABOR" | "MATERIAL" | "FEE" | "SERVICE";
  unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
  defaultQuantity: number;
  unitCost: number | null;
  unitPrice: number | null;
}>;

function parsedMoney(message: string, patterns: readonly RegExp[]) {
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replaceAll(",", ""));
    if (Number.isFinite(value) && value >= 0 && value <= 1_000_000) return value;
  }
  return null;
}

function parseProductDraft(message: string, locale: SupportedLocale = "en-US"): ProductDraft {
  const quotedName = message.match(/\b(?:as|called|named|como|llamado|llamada)\s+["']([^"']{2,120})["']/i)?.[1];
  const productName = message.match(
    /\b(?:add|create|make|save|set\s+up|agregar|agrega|anadir|anade|crear|crea|guardar|guarda|configurar|configura)\s+(?:(?:a|an|un|una)\s+)?(?:(?:new|nuevo|nueva)\s+)?(?:product(?:\s*\/\s*service)?|service|catalog\s+item|line[-\s]*item|producto(?:\s*\/\s*servicio)?|servicio|articulo\s+del\s+catalogo|partida)\s+(?:(?:as|called|named|como|llamado|llamada)\s+)?([\p{L}0-9][\p{L}0-9 /&+_-]{1,80}?)(?=\s+(?:for|with|where|that|cost|priced|at|to\s+the\s+catalog|para|con|donde|que|costo|precio|al\s+catalogo)\b|[,.;]|$)/iu,
  )?.[1];
  const fallbackName = locale === "es-US" ? "Nuevo producto o servicio" : "New product or service";
  const name = (quotedName ?? productName ?? fallbackName).trim().replace(/\s+/g, " ").slice(0, 120);
  const normalized = normalizeAssistantRoutingText(`${name} ${message}`).toLowerCase();
  const category: ProductDraft["category"] = /\b(?:labor|mano\s+de\s+obra)\b/.test(normalized)
    ? "LABOR"
    : /\bmaterial(?:es)?/.test(normalized)
      ? "MATERIAL"
      : /\bfee\b|\bpermit\b|\bdisposal\b|\btarifa\b|\bpermiso\b|\bdesecho\b/.test(normalized)
        ? "FEE"
        : "SERVICE";
  const unitType: ProductDraft["unitType"] = /\bper\s+(?:labor\s+)?hour\b|\bhourly\b|\blabor\s+hours?\b|\bpor\s+hora\b|\bhoras?\s+de\s+(?:labor|trabajo)\b/.test(normalized)
    ? "HOUR"
    : /\bper\s+(?:square|sq)\s*(?:foot|feet|ft)\b|\bsq\s*ft\b|\bsqft\b|\bpor\s+pie(?:s)?\s+cuadrad[oa]s?\b/.test(normalized)
      ? "SQ_FT"
      : /\bper\s+(?:item|unit|each)\b|\beach\b|\bpor\s+(?:articulo|unidad|pieza)\b|\bcada\b/.test(normalized)
        ? "EACH"
        : "FLAT";
  const unitCost = parsedMoney(message, [
    /\b(?:the\s+)?cost\s+internally\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\binternal(?:\s+unit)?\s+cost\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bmy\s+(?:unit\s+)?cost\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:mi\s+)?costo(?:\s+interno|\s+por\s+unidad)?\s*(?:es|de|a)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bcuesta\s+(?:internamente\s+)?\$?([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const unitPrice = parsedMoney(message, [
    /\bcustomer(?:\s+unit)?\s+price\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:charge|sell)(?:d|ing)?(?:\s+(?:the\s+)?customer)?\s+(?:is|at|of|for)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bprice(?:d)?\s+(?:to\s+the\s+customer\s+)?(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bprecio(?:\s+al\s+cliente|\s+por\s+unidad)?\s*(?:es|de|a)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:cobrar|cobramos|vender|vendemos)(?:\s+al\s+cliente)?\s*(?:a|por)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const description = locale === "es-US"
    ? unitType === "HOUR"
      ? `Precio por hora para ${name}. Confirma el trabajo incluido, los mínimos y las exclusiones antes de usarlo en cotizaciones.`
      : unitType === "SQ_FT"
        ? `Precio por pie cuadrado para ${name}. Confirma materiales, preparación y exclusiones antes de usarlo en cotizaciones.`
        : unitType === "EACH"
          ? `Precio por unidad para ${name}. Confirma la mano de obra, los materiales y las exclusiones antes de usarlo en cotizaciones.`
          : `Precio fijo para ${name}. Confirma el alcance, los materiales y las exclusiones antes de usarlo en cotizaciones.`
    : unitType === "HOUR"
      ? `Hourly ${category === "LABOR" ? "labor" : "service"} for ${name}. Confirm included work, minimums, and exclusions before using on quotes.`
      : unitType === "SQ_FT"
        ? `Per-square-foot ${category.toLowerCase()} pricing for ${name}. Confirm materials, preparation, and exclusions before using on quotes.`
        : unitType === "EACH"
          ? `Per-item pricing for ${name}. Confirm the included labor, materials, and exclusions before using on quotes.`
          : `Flat-rate pricing for ${name}. Confirm the included scope, materials, and exclusions before using on quotes.`;

  return {
    name,
    description,
    category,
    unitType,
    defaultQuantity: 1,
    unitCost,
    unitPrice,
  };
}

async function runProductDraftPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "manageCatalog")) {
    const answer = localeText(
      params,
      "Only a workspace owner or admin can add or change products. I can still help you build an assigned quote with products they have approved.",
      "Solo el propietario o un administrador puede agregar o cambiar productos. Aun así, puedo ayudarte a preparar una cotización asignada con productos ya aprobados.",
    );
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C1_BUSINESS_INTERNAL",
      sourceTypes: ["WorkPreset"],
      sourceLabels: ["Catalog management denied"],
      creditsConsumed: 0,
      telemetry: ZERO_AI_TELEMETRY,
      riskNote: "Denied before creating a product draft because members cannot manage the tenant catalog.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "DRAFT_PRODUCT",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C1_BUSINESS_INTERNAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: localeText(params, "Ask an admin to add this product", "Pedir a un administrador que agregue este producto"), requiresConfirmation: true, payload: { capability: "manageCatalog" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "DRAFT_PRODUCT",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Catalog drafting denied for member role.",
          archivePolicy: "No catalog rows were read or written.",
          filters: { currentPage: params.context?.currentPage },
        }),
      },
    };
  }
  const draft = parseProductDraft(params.message, assistantLocale(params));
  const canViewInternalCosts = hasCapability(params.access, "viewInternalCosts");
  const visibleUnitCost = canViewInternalCosts ? draft.unitCost : null;
  const serviceType = params.context?.serviceType ?? null;
  const missing = [
    ["New product or service", "Nuevo producto o servicio"].includes(draft.name)
      ? localeText(params, "name", "nombre")
      : null,
    draft.unitPrice === null ? localeText(params, "customer price", "precio al cliente") : null,
  ].filter((value): value is string => Boolean(value));
  const answer = missing.length
    ? localeText(
        params,
        `I prepared a product draft. Add the ${missing.join(" and ")} in the review form before saving it to your catalog.`,
        `Preparé un borrador del producto. Agrega ${missing.join(" y ")} en el formulario de revisión antes de guardarlo en tu catálogo.`,
      )
    : localeText(
        params,
        `I prepared ${draft.name} as a ${draft.unitType === "HOUR" ? "per-hour" : draft.unitType === "SQ_FT" ? "per-square-foot" : draft.unitType === "EACH" ? "per-item" : "flat-rate"} catalog item. Review the pricing and description before saving.`,
        `Preparé ${draft.name} como un artículo de catálogo con precio ${draft.unitType === "HOUR" ? "por hora" : draft.unitType === "SQ_FT" ? "por pie cuadrado" : draft.unitType === "EACH" ? "por unidad" : "fijo"}. Revisa el precio y la descripción antes de guardarlo.`,
      );
  const maxClassification: DataClassification = draft.unitCost !== null
    ? "C3_FINANCIAL_CONFIDENTIAL"
    : "C2_CUSTOMER_CONFIDENTIAL";
  const result = {
    name: draft.name,
    serviceType,
    category: draft.category,
    unitType: draft.unitType,
    defaultQuantity: draft.defaultQuantity,
    unitCost: visibleUnitCost,
    unitPrice: draft.unitPrice,
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: maxClassification,
    sourceTypes: ["WorkPreset"],
    sourceLabels: ["User-supplied product draft"],
    serviceType,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: missing.length ? "medium" : "high",
    confidenceLabel: "Deterministic product draft parser",
    riskNote: "No catalog row was created. The user must review and explicitly save the tenant-scoped product form.",
  });
  const fieldsExcluded = [
    ...defaultExcludedFields(canViewInternalCosts),
    ...(!canViewInternalCosts && draft.unitCost !== null ? ["user-supplied internal cost"] : []),
  ];

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "DRAFT_PRODUCT",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification,
      answer,
      results: [result],
      citations: [{
        key: "A1",
        label: localeText(params, "Product details supplied in this request", "Detalles del producto proporcionados en esta solicitud"),
        sourceType: "WorkPreset",
        classification: maxClassification,
      }],
      actions: [{
        type: "OPEN_PRODUCT_DRAFT",
        label: localeText(params, "Review product draft", "Revisar borrador del producto"),
        requiresConfirmation: true,
        payload: {
          ...draft,
          unitCost: visibleUnitCost,
          serviceType,
        },
      }],
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "DRAFT_PRODUCT",
        resultCount: 1,
        citationCount: 1,
        emptyReason: null,
        archivePolicy: "Product drafting does not read archived, deleted, or cross-tenant catalog rows.",
        filters: {
          currentPage: params.context?.currentPage,
          serviceType,
          internalCostVisible: canViewInternalCosts,
          missingFields: missing.join(",") || null,
        },
      }),
    },
  };
}

async function runCustomerDraftPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const combinedPrompt = [
    ...(params.conversation ?? [])
      .filter((turn) => turn.resolvedTool === "DRAFT_CUSTOMER")
      .map((turn) => turn.message),
    params.message,
  ].slice(-3).join("\n");
  const draft = parseCustomerDraft(combinedPrompt);
  const missingFields = [
    ...(!draft.fullName ? [localeText(params, "full name", "nombre completo")] : []),
    ...(!draft.phone ? [localeText(params, "10-digit phone", "teléfono de 10 dígitos")] : []),
  ];
  const ready = missingFields.length === 0;
  const answer = ready
    ? localeText(
        params,
        `I prepared a customer draft for ${draft.fullName}. Open it to review the contact details; nothing is saved until you press Save customer.`,
        `Preparé un borrador de cliente para ${draft.fullName}. Ábrelo para revisar los datos de contacto; nada se guarda hasta que presiones Guardar cliente.`,
      )
    : localeText(
        params,
        `I can add the customer. I still need ${missingFields.join(" and ")}. Reply with those details and I’ll prepare the review form.`,
        `Puedo agregar al cliente. Todavía necesito ${missingFields.join(" y ")}. Responde con esos datos y prepararé el formulario de revisión.`,
      );
  const result = {
    fullName: draft.fullName,
    phone: draft.phone,
    email: draft.email,
    notes: draft.notes,
    missingFields: missingFields.join(", ") || null,
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer"],
    sourceLabels: ["Customer details supplied in this request"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: ready ? "high" : "medium",
    confidenceLabel: "Deterministic customer draft parser",
    riskNote: "No customer row was created. The existing duplicate-safe customer form remains authoritative.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "DRAFT_CUSTOMER",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: [result],
      citations: [{
        key: "A1",
        label: localeText(params, "Customer details supplied in this request", "Datos del cliente proporcionados en esta solicitud"),
        sourceType: "Customer",
        classification: "C2_CUSTOMER_CONFIDENTIAL",
      }],
      actions: ready ? [{
        type: "OPEN_CUSTOMER_DRAFT",
        label: localeText(params, "Review customer draft", "Revisar borrador del cliente"),
        requiresConfirmation: true,
        payload: draft,
      }] : [],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "DRAFT_CUSTOMER",
        resultCount: 1,
        citationCount: 1,
        emptyReason: ready ? null : `Missing required fields: ${missingFields.join(", ")}.`,
        archivePolicy: "Customer drafting does not read or mutate customer rows.",
        filters: {
          currentPage: params.context?.currentPage,
          readyForReview: ready,
          missingFields: missingFields.join(", ") || null,
        },
      }),
    },
  };
}

async function runPrepareQuoteSend(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewTenantQuotes") || !hasCapability(params.access, "viewCustomerPii")) {
    const answer = localeText(
      params,
      "Preparing a quote to send requires access to the assigned quote and customer contact details.",
      "Preparar una cotización para enviar requiere acceso a la cotización asignada y a los datos de contacto del cliente.",
    );
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Quote", "Customer"],
      sourceLabels: ["Quote send preparation denied"],
      creditsConsumed: 0,
      telemetry: ZERO_AI_TELEMETRY,
      riskNote: "Denied before quote retrieval because the actor lacks quote or customer access.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "PREPARE_QUOTE_SEND",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{
          type: "REQUEST_ADMIN_ACCESS",
          label: localeText(params, "Ask an admin for quote access", "Solicitar acceso a cotizaciones"),
          requiresConfirmation: true,
          payload: { capabilities: ["viewTenantQuotes", "viewCustomerPii"] },
        }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "PREPARE_QUOTE_SEND",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Quote send preparation denied before retrieval.",
          archivePolicy: "No quote rows are retrieved when access is denied.",
          filters: { currentPage: params.context?.currentPage },
        }),
      },
    };
  }

  const combinedPrompt = [
    ...(params.conversation ?? [])
      .filter((turn) => turn.resolvedTool === "PREPARE_QUOTE_SEND")
      .map((turn) => turn.message),
    params.message,
  ].slice(-2).join(" ");
  const searchTokens = quoteSendSearchTokens(combinedPrompt);
  const normalizedSendMessage = normalizeAssistantRoutingText(params.message);
  const requestedChannel = /\b(?:text|sms|message|texto|mensaje)\b/i.test(normalizedSendMessage)
    ? "sms"
    : /\b(?:email|mail|correo)\b/i.test(normalizedSendMessage)
      ? "email"
      : null;
  const quoteWhere: Prisma.QuoteWhereInput = {
    ...tenantActiveQuoteScope(params.access.tenantId),
    ...assignedQuoteScope(params.access),
    customer: {
      is: {
        ...tenantActiveCustomerScope(params.access.tenantId),
        ...assignedCustomerScope(params.access),
      },
    },
    status: { in: ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER"] },
    ...(params.context?.quoteId
      ? { id: params.context.quoteId }
      : searchTokens.length
        ? {
            AND: searchTokens.map((token) => ({
              OR: [
                { title: { contains: token, mode: "insensitive" } },
                { customer: { fullName: { contains: token, mode: "insensitive" } } },
                { customer: { email: { contains: token, mode: "insensitive" } } },
              ],
            })),
          }
        : {}),
  };
  const candidates = await prisma.quote.findMany({
    where: quoteWhere,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: params.context?.quoteId ? 1 : 5,
    select: {
      id: true,
      title: true,
      status: true,
      totalAmount: true,
      updatedAt: true,
      customerId: true,
      customer: { select: { fullName: true, email: true, phone: true } },
    },
  });
  const selectedCandidates = /\b(?:latest|ultima|ultimo|mas\s+reciente)\b/i.test(normalizedSendMessage) && candidates.length ? candidates.slice(0, 1) : candidates;
  const results = selectedCandidates.map((quote) => ({
    quoteId: quote.id,
    quoteTitle: quote.title,
    quoteStatus: quote.status,
    quoteAmount: Number(quote.totalAmount),
    customerName: quote.customer.fullName,
    recipient: requestedChannel === "sms"
      ? formatUsPhone(quote.customer.phone)
      : requestedChannel === "email"
        ? quote.customer.email
        : quote.customer.email ?? formatUsPhone(quote.customer.phone),
    updatedAtUtc: quote.updatedAt.toISOString(),
  }));
  const actions: AiAssistantAction[] = selectedCandidates.flatMap((quote) => {
    const channel = requestedChannel ?? (quote.customer.email ? "email" : normalizeUsPhoneDigits(quote.customer.phone) ? "sms" : "copy");
    const destination = channel === "email"
      ? quote.customer.email
      : channel === "sms"
        ? formatUsPhone(quote.customer.phone)
        : null;
    if ((channel === "email" || channel === "sms") && !destination) return [];
    return [{
      type: "OPEN_QUOTE_SEND",
      label: localeText(
        params,
        `${quote.status === "SENT_TO_CUSTOMER" ? "Review resend" : "Review send"} · ${quote.customer.fullName}`,
        `${quote.status === "SENT_TO_CUSTOMER" ? "Revisar reenvío" : "Revisar envío"} · ${quote.customer.fullName}`,
      ),
      requiresConfirmation: true,
      payload: {
        quoteId: quote.id,
        quoteTitle: quote.title,
        quoteStatus: quote.status,
        customerName: quote.customer.fullName,
        channel,
        destination,
        totalAmount: Number(quote.totalAmount),
      },
    }];
  });
  const answer = !candidates.length
    ? params.context?.quoteId
      ? localeText(params, "I couldn’t find that active assigned quote. It may have changed, been archived, or no longer be available to you.", "No pude encontrar esa cotización activa asignada. Es posible que haya cambiado, se haya archivado o ya no esté disponible para ti.")
      : localeText(params, "I couldn’t match an active assigned quote. Tell me the customer or quote title, or open the quote and ask me again.", "No pude identificar una cotización activa asignada. Dime el cliente o el título de la cotización, o abre la cotización y vuelve a preguntarme.")
    : actions.length === 0
      ? localeText(params, `I found ${selectedCandidates.length} matching quote${selectedCandidates.length === 1 ? "" : "s"}, but the customer is missing the requested contact method. Update the customer first, then try again.`, `Encontré ${selectedCandidates.length} cotización${selectedCandidates.length === 1 ? "" : "es"}, pero falta el método de contacto solicitado. Actualiza primero al cliente y vuelve a intentarlo.`)
      : selectedCandidates.length === 1
        ? localeText(params, `I found ${selectedCandidates[0].title} for ${selectedCandidates[0].customer.fullName}. Review the recipient and message before opening the ${actions[0]?.payload.channel === "sms" ? "text" : actions[0]?.payload.channel === "copy" ? "copy" : "email"} handoff. I will not mark it sent automatically.`, `Encontré ${selectedCandidates[0].title} para ${selectedCandidates[0].customer.fullName}. Revisa el destinatario y el mensaje antes de abrir la preparación del ${actions[0]?.payload.channel === "sms" ? "texto" : actions[0]?.payload.channel === "copy" ? "enlace" : "correo"}. No la marcaré como enviada automáticamente.`)
        : localeText(params, `I found ${selectedCandidates.length} matching quotes. Choose the correct customer and quote to open the send review. Nothing will be marked sent automatically.`, `Encontré ${selectedCandidates.length} cotizaciones. Elige el cliente y la cotización correctos para abrir la revisión de envío. Nada se marcará como enviado automáticamente.`);
  const citations: AiAssistantCitation[] = candidates.length ? [{
    key: "A1",
    label: localeText(params, "Active assigned tenant quotes and current customer contact details", "Cotizaciones activas asignadas y datos de contacto actuales del cliente"),
    sourceType: "Quote + Customer",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }] : [];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Quote", "Customer"],
    sourceLabels: citations.map((citation) => citation.label),
    quoteId: selectedCandidates.length === 1 ? selectedCandidates[0]?.id ?? null : null,
    customerId: selectedCandidates.length === 1 ? selectedCandidates[0]?.customerId ?? null : null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: selectedCandidates.length === 1 ? "high" : candidates.length ? "medium" : "low",
    confidenceLabel: "Deterministic quote send preparation",
    riskNote: "Kody only opens the existing two-phase send review. It does not contact the customer or mark the quote sent.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PREPARE_QUOTE_SEND",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PREPARE_QUOTE_SEND",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: candidates.length ? null : "No active assigned quote matched the trusted context or bounded search terms.",
        archivePolicy: "Only active, assigned tenant quotes in draft, ready, or sent status are eligible.",
        filters: {
          currentPage: params.context?.currentPage,
          scopedQuote: Boolean(params.context?.quoteId),
          searchTokenCount: searchTokens.length,
          requestedChannel,
          candidateCount: candidates.length,
        },
      }),
    },
  };
}

async function runWorkspaceNavigation(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const target = navigationTarget(params.message) ?? (
    params.context?.currentPage === "customers" ||
    params.context?.currentPage === "quotes" ||
    params.context?.currentPage === "products" ||
    params.context?.currentPage === "analytics"
      ? params.context.currentPage
      : "customers"
  );
  const catalogRestricted = target === "products" && !hasCapability(params.access, "manageCatalog");
  const authorizedTarget = catalogRestricted ? "quotes" : target;
  const label = workspacePageLabel(authorizedTarget, assistantLocale(params));
  const answer = catalogRestricted
    ? localeText(params, "The product catalog is managed by workspace owners and admins. I can take you to your assigned quotes, where you can use products they have approved.", "El catálogo de productos lo administran los propietarios y administradores. Puedo llevarte a tus cotizaciones asignadas, donde puedes usar productos ya aprobados.")
    : localeText(params, `I can take you to ${label}. Your Kody conversation will stay open while you move.`, `Puedo llevarte a ${label}. Tu conversación con Kody seguirá abierta mientras navegas.`);
  const action: AiAssistantAction = {
    type: "OPEN_WORKSPACE_PAGE",
    label: localeText(params, `Open ${label}`, `Abrir ${label}`),
    requiresConfirmation: false,
    payload: { page: authorizedTarget },
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C1_BUSINESS_INTERNAL",
    sourceTypes: [],
    sourceLabels: [catalogRestricted ? "Catalog navigation restricted by role" : "Approved workspace navigation"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic navigation",
    riskNote: catalogRestricted
      ? "Catalog management navigation was replaced with assigned quote navigation for a member role."
      : "No workspace records or external AI provider were used for navigation.",
  });
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "NAVIGATE_WORKSPACE",
    resultCount: 0,
    citationCount: 0,
    archivePolicy: "Navigation does not retrieve customer or quote rows.",
    filters: { targetPage: authorizedTarget, requestedPage: target, catalogRestricted },
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "NAVIGATE_WORKSPACE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C1_BUSINESS_INTERNAL",
      answer,
      results: [],
      citations: [],
      actions: [action],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: baseDiagnostics,
    },
  };
}

async function createDeniedCustomerToolResult(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "FOLLOW_UP_QUEUE" | "CUSTOMERS_WITHOUT_QUOTES",
): Promise<AiAssistantRunResult> {
  const answer = localeText(params, "This request requires permission to view customer and quote details.", "Esta solicitud requiere permiso para ver los detalles de clientes y cotizaciones.");
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [`${tool} denied`],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    riskNote: "Denied before customer data retrieval because the actor lacks viewCustomerPii.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: [],
      citations: [],
      actions: [{
        type: "REQUEST_ADMIN_ACCESS",
        label: localeText(params, "Ask an admin for customer access", "Solicitar acceso a clientes"),
        requiresConfirmation: true,
        payload: { capability: "viewCustomerPii" },
      }],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: 0,
        citationCount: 0,
        emptyReason: "Customer retrieval denied before query execution.",
        archivePolicy: "No customer or quote rows are retrieved when customer PII access is denied.",
        filters: { includeArchivedEffective: false },
      }),
    },
  };
}

type ActivityDueBucket = "OVERDUE" | "TODAY" | "UPCOMING";

function activityDueBucket(
  task: Pick<AssistantActivityTaskProjection, "dueAtUtc">,
  windows: { todayStartUtc: Date; tomorrowStartUtc: Date },
): ActivityDueBucket {
  if (task.dueAtUtc < windows.todayStartUtc) return "OVERDUE";
  if (task.dueAtUtc < windows.tomorrowStartUtc) return "TODAY";
  return "UPCOMING";
}

function activityTaskResult(
  task: AssistantActivityTaskProjection,
  index: number,
  windows: { todayStartUtc: Date; tomorrowStartUtc: Date },
) {
  return {
    activityTaskId: task.id,
    activityTaskVersion: task.version,
    activityRank: index + 1,
    title: task.title,
    taskType: task.type,
    priority: task.priority,
    status: task.status,
    dueBucket: activityDueBucket(task, windows),
    dueAtUtc: task.dueAtUtc.toISOString(),
    customerName: task.customer.fullName,
    quoteTitle: task.quote?.title ?? null,
  };
}

function activityTaskNoun(count: number, locale: SupportedLocale) {
  if (locale === "es-US") return count === 1 ? "tarea activa" : "tareas activas";
  return count === 1 ? "active task" : "active tasks";
}

function shouldLimitActivityToToday(message: string, tool: "LIST_MY_ACTIVITIES" | "PRIORITIZE_MY_DAY") {
  return tool === "PRIORITIZE_MY_DAY" || ACTIVITY_TODAY_INTENT_PATTERN.test(normalizeAssistantRoutingText(message));
}

async function runActivityAgenda(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "LIST_MY_ACTIVITIES" | "PRIORITIZE_MY_DAY",
): Promise<AiAssistantRunResult> {
  const limit = clampLimit(params.context?.limit, MAX_ACTIVITY_LIMIT, DEFAULT_ACTIVITY_LIMIT);
  const locale = assistantLocale(params);
  const todayScope = shouldLimitActivityToToday(params.message, tool);
  const activityData = await withTenantRlsContext(prisma, params.access.tenantId, async (transaction) => {
    const tenant = await transaction.tenant.findFirst({
      where: { id: params.access.tenantId, deletedAtUtc: null },
      select: { timezone: true },
    });
    const windows = tenantActivityWindows(generatedAtUtc, tenant?.timezone ?? "UTC");
    const agenda = await summarizeAssistantActivityAgenda(transaction, params.access, windows, {
      limit,
      prioritizeTodayOnly: todayScope,
    });

    return {
      timeZone: windows.timeZone,
      windows,
      summary: agenda.counts,
      activeTotal: agenda.activeTotal,
      matchingTotal: agenda.matchingTotal,
      rankedTasks: agenda.tasks,
    };
  });

  const results = activityData.rankedTasks.map((task, index) =>
    activityTaskResult(task, index, activityData.windows),
  );
  const top = results[0] ?? null;
  const counts = activityData.summary;
  const listedTotal = todayScope ? activityData.matchingTotal : activityData.activeTotal;
  const countSummary = locale === "es-US"
    ? `${counts.overdue} vencida${counts.overdue === 1 ? "" : "s"}, ${counts.today} para hoy y ${counts.upcoming} próxima${counts.upcoming === 1 ? "" : "s"}`
    : `${counts.overdue} overdue, ${counts.today} due today, and ${counts.upcoming} upcoming`;

  const answer = top
    ? tool === "PRIORITIZE_MY_DAY"
      ? locale === "es-US"
        ? `Empezaría con "${top.title}"${top.customerName ? ` para ${top.customerName}` : ""}. Tu lista tiene ${activityData.activeTotal} ${activityTaskNoun(activityData.activeTotal, locale)}: ${countSummary}. Usé solo tus tareas activas asignadas.`
        : `I would start with "${top.title}"${top.customerName ? ` for ${top.customerName}` : ""}. Today's list has ${activityData.matchingTotal} ${activityTaskNoun(activityData.matchingTotal, locale)}: ${countSummary}. I only used your assigned active tasks.`
      : locale === "es-US"
        ? `Encontré ${activityData.activeTotal} ${activityTaskNoun(activityData.activeTotal, locale)} en tu lista: ${countSummary}. Se muestran las ${results.length} más importantes.`
        : `I found ${listedTotal} ${activityTaskNoun(listedTotal, locale)} on your list: ${countSummary}. Showing ${results.length}.`
    : activityData.activeTotal > 0
      ? locale === "es-US"
        ? `No encontré tareas vencidas ni tareas para hoy asignadas a ti. Tienes ${activityData.activeTotal} ${activityTaskNoun(activityData.activeTotal, locale)} programadas para más adelante.`
        : `I did not find overdue tasks or tasks due today assigned to you. You have ${activityData.activeTotal} ${activityTaskNoun(activityData.activeTotal, locale)} scheduled later.`
    : locale === "es-US"
      ? `No encontré tareas activas asignadas a ti. Completaste ${counts.completed} en la ventana reciente.`
      : `I did not find active tasks assigned to you. You completed ${counts.completed} in the recent window.`;

  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Assigned active activity tasks", "Tareas activas asignadas"),
    sourceType: "ActivityTask + Customer + Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["ActivityTask", "Customer", "Quote"],
    sourceLabels: [citations[0].label],
    customerId: activityData.rankedTasks[0]?.customerId ?? null,
    quoteId: activityData.rankedTasks[0]?.quoteId ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic assigned activity summary",
    riskNote: "Activity lookup used the same tenant-scoped visibility predicate and RLS context as the authenticated activities API. Task notes, contact details, deleted rows, and archived linked records were excluded from the assistant result.",
    insightReasons: [tool === "PRIORITIZE_MY_DAY" ? "assigned activity prioritization" : "assigned activity listing"],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions: [{
        type: "OPEN_WORKSPACE_PAGE",
        label: localeText(params, "Open activity", "Abrir actividad"),
        requiresConfirmation: false,
        payload: { page: "follow-up" },
      }],
      auditEventId: event.id,
      fieldsExcluded: [
        ...defaultExcludedFields(false),
        "task notes",
        "customer phone numbers",
        "customer email addresses",
        "archived linked customers",
        "archived linked quotes",
        "deleted activity tasks",
      ],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length
          ? null
          : activityData.activeTotal > 0
            ? "Visible active tasks exist, but none are overdue or due today for the day-prioritization view."
            : "No visible active tasks were assigned to the signed-in user.",
        archivePolicy: "Only active tasks with active linked customers and quotes are considered.",
        filters: {
          mine: true,
          statuses: ACTIVE_ACTIVITY_STATUSES.join(","),
          overdue: counts.overdue,
          today: counts.today,
          upcoming: counts.upcoming,
          completedRecent: counts.completed,
          totalActiveAssigned: activityData.activeTotal,
          matchingActiveAssigned: activityData.matchingTotal,
          dueWindow: todayScope ? "overdue_or_today" : "active",
          timeZone: activityData.timeZone,
          limit,
        },
      }),
    },
  };
}

async function runActivityDraftPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const locale = assistantLocale(params);
  const draftData = await withTenantRlsContext(prisma, params.access.tenantId, async (transaction) => {
    const tenant = await transaction.tenant.findFirst({
      where: { id: params.access.tenantId, deletedAtUtc: null },
      select: { timezone: true },
    });
    const windows = tenantActivityWindows(generatedAtUtc, tenant?.timezone ?? "UTC");
    const draft = parseActivityDraft(params.message, generatedAtUtc, windows, locale, params.context?.search);
    const customerScope: Prisma.CustomerWhereInput = {
      ...tenantActiveCustomerScope(params.access.tenantId),
      ...assignedCustomerScope(params.access),
    };
    const contextCustomerId = params.context?.customerId?.trim();
    const customerFilters: Prisma.CustomerWhereInput[] = [];
    if (draft.customerSearch.length >= 2) {
      customerFilters.push({ fullName: { contains: draft.customerSearch, mode: "insensitive" } });
      for (const token of searchableTokens(draft.customerSearch)) {
        customerFilters.push({ fullName: { contains: token, mode: "insensitive" } });
      }
    }
    const customerMatches = contextCustomerId
      ? await transaction.customer.findMany({
          where: { ...customerScope, id: contextCustomerId },
          select: { id: true, fullName: true },
          take: 1,
        })
      : customerFilters.length
        ? await transaction.customer.findMany({
            where: { ...customerScope, OR: customerFilters },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            select: { id: true, fullName: true },
            take: 4,
          })
        : [];
    const exactCustomer = customerMatches.length === 1 ? customerMatches[0] : null;
    const quote = exactCustomer
      ? await transaction.quote.findFirst({
          where: {
            ...tenantActiveQuoteScope(params.access.tenantId),
            ...assignedQuoteScope(params.access),
            customerId: exactCustomer.id,
            ...(params.context?.quoteId ? { id: params.context.quoteId } : {}),
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: { id: true, title: true },
        })
      : null;
    return {
      timeZone: windows.timeZone,
      draft,
      customerMatches,
      exactCustomer,
      quote,
    };
  });

  const hasExactCustomer = Boolean(draftData.exactCustomer);
  const results = hasExactCustomer
    ? [{
        customerId: draftData.exactCustomer!.id,
        fullName: draftData.exactCustomer!.fullName,
        quoteId: draftData.quote?.id ?? null,
        quoteTitle: draftData.quote?.title ?? null,
        taskType: draftData.draft.type,
        priority: draftData.draft.priority,
        title: draftData.draft.title,
        dueAtUtc: draftData.draft.dueAtUtc.toISOString(),
      }]
    : draftData.customerMatches.map((customer) => ({
        customerId: customer.id,
        fullName: customer.fullName,
      }));
  const baseDueTimeNote = draftData.draft.dueTimeSource === "EXPLICIT"
    ? localeText(params, "I used the due time from your request.", "Usé la hora de vencimiento de tu solicitud.")
    : localeText(
        params,
        "I used a reviewable default due time because no exact time was included.",
        "Usé una hora predeterminada revisable porque no incluiste una hora exacta.",
      );
  const dueTimeNote = draftData.draft.dueTimeWarning === "NONEXISTENT_LOCAL_TIME"
    ? localeText(
        params,
        "The requested local time is not valid in your workspace timezone, so I used a reviewable default due time.",
        "La hora local solicitada no es válida en la zona horaria del espacio, así que usé una hora predeterminada revisable.",
      )
    : baseDueTimeNote;
  const baseAnswer = hasExactCustomer
    ? localeText(
        params,
        `I prepared an activity task preview for ${draftData.exactCustomer!.fullName}. ${dueTimeNote} Review it before saving; nothing has been created yet.`,
        `Preparé una vista previa de tarea para ${draftData.exactCustomer!.fullName}. Revísala antes de guardar; todavía no se ha creado nada.`,
      )
    : draftData.customerMatches.length
      ? localeText(
          params,
          `I found ${draftData.customerMatches.length} possible customers. Choose the right customer before creating the activity task.`,
          `Encontré ${draftData.customerMatches.length} clientes posibles. Elige el cliente correcto antes de crear la tarea.`,
        )
      : localeText(
          params,
        "I need one active customer before preparing an activity task. Open Activity and choose the customer, or ask again with the customer name.",
        "Necesito un cliente activo antes de preparar una tarea. Abre Actividad y elige el cliente, o vuelve a pedirlo con el nombre del cliente.",
      );
  const answer = hasExactCustomer && locale === "es-US"
    ? `Preparé una vista previa de tarea para ${draftData.exactCustomer!.fullName}. ${dueTimeNote} Revísala antes de guardar; todavía no se ha creado nada.`
    : baseAnswer;
  const citations: AiAssistantCitation[] = draftData.customerMatches.length
    ? [{
        key: "A1",
        label: localeText(params, "Active tenant customer lookup for task preview", "Búsqueda de cliente activo para vista previa de tarea"),
        sourceType: "Customer",
        classification: "C2_CUSTOMER_CONFIDENTIAL",
      }]
    : [];
  const actions: AiAssistantAction[] = hasExactCustomer
    ? [{
        type: "OPEN_ACTIVITY_DRAFT",
        label: localeText(params, "Review activity task", "Revisar tarea"),
        requiresConfirmation: true,
        payload: {
          customerId: draftData.exactCustomer!.id,
          customerName: draftData.exactCustomer!.fullName,
          quoteId: draftData.quote?.id ?? null,
          quoteTitle: draftData.quote?.title ?? null,
          type: draftData.draft.type,
          priority: draftData.draft.priority,
          title: draftData.draft.title,
          dueAtUtc: draftData.draft.dueAtUtc.toISOString(),
        },
      }]
    : draftData.customerMatches.map((customer) => ({
        type: "OPEN_CUSTOMER",
        label: localeText(params, `Open ${customer.fullName}`, `Abrir a ${customer.fullName}`),
        requiresConfirmation: false,
        payload: { customerId: customer.id },
      }));
  if (!actions.length) {
    actions.push({
      type: "OPEN_WORKSPACE_PAGE",
      label: localeText(params, "Open activity", "Abrir actividad"),
      requiresConfirmation: false,
      payload: { page: "follow-up" },
    });
  }
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["ActivityTask", "Customer", "Quote"],
    sourceLabels: citations.length ? [citations[0].label] : ["Activity task preview without customer match"],
    customerId: draftData.exactCustomer?.id ?? null,
    quoteId: draftData.quote?.id ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: hasExactCustomer ? "high" : "medium",
    confidenceLabel: "Deterministic activity task preview",
    insightReasons: ["review-only activity task preview", hasExactCustomer ? "one active customer resolved" : "customer selection required"],
    riskNote: "Activity preview creates no task rows or activity events. The save action must go through POST /v1/activities, which revalidates tenant membership, assignment, linked records, and idempotency.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PREPARE_ACTIVITY",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [
        ...defaultExcludedFields(false),
        "task notes",
        "customer phone numbers",
        "customer email addresses",
        "assignee emails",
        "source keys",
        "idempotency keys",
        "created tasks",
      ],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PREPARE_ACTIVITY",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active customer could be resolved for the activity preview.",
        archivePolicy: "Only active customers and active linked quotes are eligible for activity previews.",
        filters: {
          customerSearchProvided: Boolean(draftData.draft.customerSearch),
          customerMatchCount: draftData.customerMatches.length,
          exactCustomer: hasExactCustomer,
          taskType: draftData.draft.type,
          priority: draftData.draft.priority,
          dueAtUtc: draftData.draft.dueAtUtc.toISOString(),
          timeZone: draftData.timeZone,
        },
      }),
    },
  };
}

async function runScheduleList(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const schedule = await withTenantRlsContext(prisma, params.access.tenantId, async (transaction) => {
    const tenant = await transaction.tenant.findFirst({
      where: { id: params.access.tenantId, deletedAtUtc: null },
      select: { timezone: true },
    });
    return listAssistantSchedule(transaction, params.access, {
      message: params.message,
      now: generatedAtUtc,
      timeZone: tenant?.timezone ?? "UTC",
      limit: params.context?.limit ?? DEFAULT_SCHEDULE_LIMIT,
    });
  });
  const count = schedule.items.length;
  const rangeLabel = schedule.range === "TODAY"
    ? localeText(params, "today", "hoy")
    : schedule.range === "TOMORROW"
      ? localeText(params, "tomorrow", "mañana")
      : schedule.range === "WEEK"
        ? localeText(params, "this week", "esta semana")
        : localeText(params, "the next 7 days", "los próximos 7 días");
  const scopeLabel = schedule.mine
    ? localeText(params, "assigned to you", "asignadas a ti")
    : localeText(params, "across the workspace", "en todo el espacio de trabajo");
  const answer = count
    ? localeText(
        params,
        `I found ${count} active booking${count === 1 ? "" : "s"} ${scopeLabel} for ${rangeLabel}${schedule.hasMore ? "; open Schedule to see the rest" : ""}.`,
        `Encontré ${count} cita${count === 1 ? " activa" : "s activas"} ${scopeLabel} para ${rangeLabel}${schedule.hasMore ? "; abre Agenda para ver las demás" : ""}.`,
      )
    : localeText(
        params,
        `I did not find active bookings ${scopeLabel} for ${rangeLabel}.`,
        `No encontré citas activas ${scopeLabel} para ${rangeLabel}.`,
      );
  const citations: AiAssistantCitation[] = [{
    key: "S1",
    label: localeText(params, "Visible active job schedule", "Agenda activa visible"),
    sourceType: "JobAppointment + Job + Customer + TenantUser",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    auditSummary: `Deterministic schedule listing completed with ${count} result(s).`,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["JobAppointment", "Job", "Customer", "TenantUser"],
    sourceLabels: ["Visible active job schedule"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic tenant-scoped schedule lookup",
    insightReasons: ["bounded schedule window", schedule.mine ? "self assignment scope" : "authorized workspace scope"],
    riskNote: "The schedule query ran under tenant RLS and the authenticated job visibility policy. Address, instructions, contact details, quote data, and financial fields were neither selected nor returned.",
  });
  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "LIST_SCHEDULE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: schedule.items,
      citations,
      actions: [{
        type: "OPEN_SCHEDULE",
        label: localeText(params, "Open schedule", "Abrir agenda"),
        requiresConfirmation: false,
        payload: {
          // NEXT_7_DAYS starts on the tenant-local date when Kody ran. Keep it
          // distinct from a calendar week so opening Jobs does not move a
          // Saturday/Sunday rolling interval back to the preceding Monday.
          range: schedule.range === "TODAY" || schedule.range === "TOMORROW"
            ? "day"
            : schedule.range === "NEXT_7_DAYS"
              ? "next7"
              : "week",
          date: schedule.date,
          mine: schedule.mine,
        },
      }],
      auditEventId: event.id,
      fieldsExcluded: [
        ...defaultExcludedFields(false),
        "service addresses",
        "job access instructions",
        "appointment instructions",
        "customer phone numbers",
        "customer email addresses",
        "source quote data",
        "assignee email addresses",
      ],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "LIST_SCHEDULE",
        resultCount: count,
        citationCount: citations.length,
        emptyReason: count ? null : "No visible active bookings overlap the selected tenant-local window.",
        archivePolicy: "Only active appointments on active visible jobs with active linked records are included.",
        filters: {
          range: schedule.range,
          fromUtc: schedule.fromUtc.toISOString(),
          toUtc: schedule.toUtc.toISOString(),
          timeZone: schedule.timeZone,
          mine: schedule.mine,
          limit: Math.min(params.context?.limit ?? DEFAULT_SCHEDULE_LIMIT, DEFAULT_SCHEDULE_LIMIT),
          hasMore: schedule.hasMore,
        },
      }),
    },
  };
}

async function runBookingPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const preview = await withTenantRlsContext(prisma, params.access.tenantId, async (transaction) => {
    const tenant = await transaction.tenant.findFirst({
      where: { id: params.access.tenantId, deletedAtUtc: null },
      select: { timezone: true },
    });
    return prepareAssistantBooking(transaction, params.access, {
      message: params.message,
      now: generatedAtUtc,
      timeZone: tenant?.timezone ?? "UTC",
      jobId: params.context?.jobId,
      search: params.context?.search,
    });
  });
  const job = preview.job;
  const answer = preview.outcome === "FORBIDDEN"
    ? localeText(params, "Only an owner or admin can prepare a job booking. Nothing changed.", "Solo un propietario o administrador puede preparar una cita de trabajo. No cambió nada.")
    : preview.outcome === "JOB_NOT_FOUND"
      ? localeText(params, "I could not resolve one active job you can see. Include the job number or open the job and ask again. Nothing changed.", "No pude identificar un trabajo activo que puedas ver. Incluye el número del trabajo o ábrelo e inténtalo de nuevo. No cambió nada.")
      : preview.outcome === "JOB_AMBIGUOUS"
        ? localeText(params, `I found ${preview.jobMatches.length} possible jobs. Include the job number so I can prepare the right booking. Nothing changed.`, `Encontré ${preview.jobMatches.length} trabajos posibles. Incluye el número del trabajo para preparar la cita correcta. No cambió nada.`)
        : preview.outcome === "JOB_UNASSIGNED"
          ? localeText(params, "Assign this job to an active workspace member before booking it. Nothing changed.", "Asigna este trabajo a un miembro activo antes de agendarlo. No cambió nada.")
          : preview.outcome === "MISSING_DATE"
            ? localeText(params, "Include an exact date, today, or tomorrow so I can prepare the booking. Nothing changed.", "Incluye una fecha exacta, hoy o mañana para preparar la cita. No cambió nada.")
            : preview.outcome === "MISSING_TIME"
              ? localeText(params, "Include an explicit start and end time, or a start time plus duration. Use AM/PM or 24-hour time so I do not guess. Nothing changed.", "Incluye una hora explícita de inicio y fin, o una hora de inicio y duración. Usa a. m./p. m. o formato de 24 horas para evitar suposiciones. No cambió nada.")
              : preview.outcome === "INVALID_LOCAL_TIME"
                ? localeText(params, "That local time does not exist in the workspace timezone because of a daylight-saving change. Choose another time. Nothing changed.", "Esa hora local no existe en la zona horaria del espacio debido al cambio de horario. Elige otra hora. No cambió nada.")
                : preview.outcome === "PAST_TIME"
                  ? localeText(params, "That booking window is already in the past. Choose a future time. Nothing changed.", "Ese horario ya pasó. Elige una hora futura. No cambió nada.")
                  : preview.outcome === "ACTIVE_APPOINTMENT_LOCKED"
                    ? localeText(params, "This job has a dispatched or arrived visit, so I will not move it. Ask for an additional visit or review the job first. Nothing changed.", "Este trabajo tiene una visita despachada o iniciada, así que no la moveré. Pide una visita adicional o revisa el trabajo primero. No cambió nada.")
                    : preview.outcome === "APPOINTMENT_AMBIGUOUS"
                      ? localeText(params, "This job has more than one scheduled visit. Open the job and choose the visit to reschedule. Nothing changed.", "Este trabajo tiene más de una visita programada. Abre el trabajo y elige la visita que quieres reprogramar. No cambió nada.")
                      : preview.repeatedLocalTime
                        ? localeText(
                            params,
                            `That local time occurs twice because daylight saving time ends. Review one of the two offset choices (${preview.options.map((option) => option.offsetLabel).join(" or ")}); nothing changed yet.`,
                            `Esa hora local ocurre dos veces porque termina el horario de verano. Revisa una de las dos opciones de zona (${preview.options.map((option) => option.offsetLabel).join(" o ")}); todavía no cambió nada.`,
                          )
                        : localeText(
                            params,
                            `I prepared a ${preview.mode === "RESCHEDULE" ? "reschedule" : "booking"} review for job #${job!.jobNumber}, ${job!.customerName}. Review it in Jobs before saving; nothing changed yet.`,
                            `Preparé una revisión de ${preview.mode === "RESCHEDULE" ? "reprogramación" : "cita"} para el trabajo #${job!.jobNumber}, ${job!.customerName}. Revísala en Trabajos antes de guardar; todavía no cambió nada.`,
                          );
  const results = preview.outcome === "READY"
    ? preview.options.map((option, index) => ({
        option: index + 1,
        mode: preview.mode!,
        jobId: job!.jobId,
        jobNumber: job!.jobNumber,
        jobStatus: job!.jobStatus,
        jobTitle: job!.jobTitle,
        customerId: job!.customerId,
        customerName: job!.customerName,
        assignedTenantUserId: job!.assignedTenantUserId!,
        assigneeName: job!.assigneeName!,
        appointmentId: preview.appointmentId,
        appointmentVersion: preview.appointmentVersion,
        startsAtUtc: option.startsAtUtc,
        endsAtUtc: option.endsAtUtc,
        timeZone: preview.timeZone,
        offsetLabel: option.offsetLabel,
      }))
    : [...preview.jobMatches];
  const actions: AiAssistantAction[] = preview.outcome === "READY"
    ? preview.options.map((option) => ({
        type: "OPEN_BOOKING_REVIEW",
        label: preview.repeatedLocalTime
          ? localeText(params, `Review ${option.offsetLabel} option`, `Revisar opción ${option.offsetLabel}`)
          : localeText(params, preview.mode === "RESCHEDULE" ? "Review reschedule" : "Review booking", preview.mode === "RESCHEDULE" ? "Revisar reprogramación" : "Revisar cita"),
        requiresConfirmation: false,
        payload: {
          mode: preview.mode,
          jobId: job!.jobId,
          jobNumber: job!.jobNumber,
          jobTitle: job!.jobTitle,
          customerId: job!.customerId,
          customerName: job!.customerName,
          assignedTenantUserId: job!.assignedTenantUserId,
          assigneeName: job!.assigneeName,
          startsAtUtc: option.startsAtUtc,
          endsAtUtc: option.endsAtUtc,
          timeZone: preview.timeZone,
          ...(preview.appointmentId ? {
            appointmentId: preview.appointmentId,
            appointmentVersion: preview.appointmentVersion,
            expectedStatus: "SCHEDULED",
          } : {}),
        },
      }))
    : preview.outcome === "FORBIDDEN"
      ? [{
          type: "REQUEST_ADMIN_ACCESS",
          label: localeText(params, "Ask an admin to book this job", "Pedir a un administrador que agende el trabajo"),
          requiresConfirmation: true,
          payload: { capability: "manageAssignments" },
        }]
      : [];
  const citations: AiAssistantCitation[] = preview.jobMatches.length
    ? [{ key: "B1", label: localeText(params, "Visible active job booking lookup", "Búsqueda de trabajo activo visible"), sourceType: "Job + Customer + TenantUser + JobAppointment", classification: "C2_CUSTOMER_CONFIDENTIAL" }]
    : [];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    auditSummary: `Deterministic booking preview completed with outcome ${preview.outcome}.`,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Job", "Customer", "TenantUser", "JobAppointment"],
    sourceLabels: ["Review-only job booking lookup"],
    customerId: preview.outcome === "READY" ? job?.customerId ?? null : null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: preview.outcome === "READY" ? "high" : "medium",
    confidenceLabel: "Deterministic review-only booking preview",
    insightReasons: ["no business write", `booking outcome=${preview.outcome}`],
    riskNote: "The preview created no job, appointment, or job-event rows. Opening the review is navigation only; the existing booking API remains the sole write path and revalidates tenant access, assignment, overlap, timezone, and lifecycle state.",
  });
  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PREPARE_BOOKING",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [
        ...defaultExcludedFields(false),
        "service addresses",
        "job scope",
        "job access instructions",
        "appointment instructions",
        "customer contact details",
        "source quote data",
        "created or updated appointments",
        "job events",
      ],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PREPARE_BOOKING",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: preview.outcome === "READY" ? null : `Booking preview stopped with outcome ${preview.outcome}.`,
        archivePolicy: "Only active visible jobs, active assignees, and active appointments are eligible for booking review.",
        filters: {
          outcome: preview.outcome,
          mode: preview.mode,
          jobMatchCount: preview.jobMatches.length,
          timeZone: preview.timeZone,
          optionCount: preview.options.length,
          repeatedLocalTime: preview.repeatedLocalTime,
          writesPerformed: false,
        },
      }),
    },
  };
}

async function runDispatchPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const preview = await withTenantRlsContext(prisma, params.access.tenantId, (transaction) =>
    prepareAssistantDispatch(transaction, params.access, {
      message: params.message,
      now: generatedAtUtc,
      jobId: params.context?.jobId,
      appointmentId: params.context?.appointmentId,
      search: params.context?.search,
    }));
  const item = preview.item;
  const answer = preview.outcome === "READY"
    ? localeText(
        params,
        `Job #${item!.jobNumber}, ${item!.customerName}, is scheduled and ready for dispatch review. Confirm dispatch in Jobs; nothing changed yet.`,
        `El trabajo #${item!.jobNumber}, ${item!.customerName}, está programado y listo para revisar el despacho. Confirma el despacho en Trabajos; todavía no cambió nada.`,
      )
    : preview.outcome === "JOB_AMBIGUOUS"
      ? localeText(params, `I found ${preview.jobMatches.length} possible jobs. Include the job number before dispatching. Nothing changed.`, `Encontré ${preview.jobMatches.length} trabajos posibles. Incluye el número del trabajo antes de despachar. No cambió nada.`)
      : preview.outcome === "APPOINTMENT_AMBIGUOUS"
        ? localeText(params, "This job has more than one scheduled visit. Open the job and choose the visit to dispatch. Nothing changed.", "Este trabajo tiene más de una visita programada. Abre el trabajo y elige la visita que quieres despachar. No cambió nada.")
        : preview.outcome === "APPOINTMENT_NOT_FOUND"
          ? localeText(params, "I could not find one scheduled visit you are allowed to dispatch. It may already be dispatched, arrived, completed, or outside your assignment. Nothing changed.", "No encontré una visita programada que puedas despachar. Puede que ya esté despachada, iniciada, terminada o fuera de tu asignación. No cambió nada.")
          : localeText(params, "I could not resolve one active job you can see. Include the job number or ask to dispatch your next job. Nothing changed.", "No pude identificar un trabajo activo que puedas ver. Incluye el número o pide despachar tu próximo trabajo. No cambió nada.");
  const results = item ? [item] : [...preview.jobMatches];
  const actions: AiAssistantAction[] = item
    ? [{
        type: "OPEN_DISPATCH_REVIEW",
        label: localeText(params, "Review dispatch", "Revisar despacho"),
        requiresConfirmation: false,
        payload: {
          jobId: item.jobId,
          jobNumber: item.jobNumber,
          jobTitle: item.jobTitle,
          customerId: item.customerId,
          customerName: item.customerName,
          appointmentId: item.appointmentId,
          appointmentVersion: item.appointmentVersion,
          expectedStatus: "SCHEDULED",
          startsAtUtc: item.startsAtUtc,
          endsAtUtc: item.endsAtUtc,
          timeZone: item.timeZone,
          assignedTenantUserId: item.assignedTenantUserId,
          assigneeName: item.assigneeName,
        },
      }]
    : [];
  const citations: AiAssistantCitation[] = item || preview.jobMatches.length
    ? [{ key: "D1", label: localeText(params, "Visible scheduled dispatch lookup", "Búsqueda de despacho programado visible"), sourceType: "JobAppointment + Job + Customer + TenantUser", classification: "C2_CUSTOMER_CONFIDENTIAL" }]
    : [];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    auditSummary: `Deterministic dispatch preview completed with outcome ${preview.outcome}.`,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["JobAppointment", "Job", "Customer", "TenantUser"],
    sourceLabels: ["Review-only scheduled dispatch lookup"],
    customerId: item?.customerId ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: item ? "high" : "medium",
    confidenceLabel: "Deterministic review-only dispatch preview",
    insightReasons: ["scheduled appointment required", "no business write", `dispatch outcome=${preview.outcome}`],
    riskNote: "The preview created no appointment or job-event rows. Opening the review is navigation only; the existing status-only appointment API remains the sole write path and revalidates tenant membership, assignment, version, and SCHEDULED lifecycle state.",
  });
  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PREPARE_DISPATCH",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [
        ...defaultExcludedFields(false),
        "service addresses",
        "job scope",
        "job access instructions",
        "appointment instructions",
        "customer contact details",
        "source quote data",
        "appointment status updates",
        "job events",
      ],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PREPARE_DISPATCH",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: item ? null : `Dispatch preview stopped with outcome ${preview.outcome}.`,
        archivePolicy: "Only active visible jobs with exactly one visible SCHEDULED appointment are eligible for dispatch review.",
        filters: {
          outcome: preview.outcome,
          jobMatchCount: preview.jobMatches.length,
          expectedStatus: "SCHEDULED",
          writesPerformed: false,
        },
      }),
    },
  };
}

async function runCustomersWithoutQuotes(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    return createDeniedCustomerToolResult(prisma, params, generatedAtUtc, "CUSTOMERS_WITHOUT_QUOTES");
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const where: Prisma.CustomerWhereInput = {
    ...tenantActiveCustomerScope(params.access.tenantId),
    ...assignedCustomerScope(params.access),
    quotes: { none: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) } },
  };
  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        fullName: true,
        followUpStatus: true,
        createdAt: true,
      },
    }),
  ]);
  const results = customers.map((customer) => ({
    customerId: customer.id,
    fullName: customer.fullName,
    followUpStatus: customer.followUpStatus,
    activeQuoteCount: 0,
    customerSinceUtc: customer.createdAt.toISOString(),
  }));
  const answer = total
    ? localeText(params, `${total} active customer${total === 1 ? " has" : "s have"} no active quote. Showing ${customers.length}; open a customer to start one.`, `${total} cliente${total === 1 ? " activo no tiene" : "s activos no tienen"} una cotización activa. Se muestran ${customers.length}; abre un cliente para comenzar una.`)
    : localeText(params, "Every active customer currently has at least one active quote.", "Todos los clientes activos tienen al menos una cotización activa.");
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Active tenant customers without active quotes", "Clientes activos sin cotizaciones activas"),
    sourceType: "Customer + Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const actions: AiAssistantAction[] = customers.map((customer) => ({
    type: "OPEN_CUSTOMER",
    label: localeText(params, `Open ${customer.fullName}`, `Abrir a ${customer.fullName}`),
    requiresConfirmation: false,
    payload: { customerId: customer.id },
  }));
  if (!customers.length) {
    actions.push({
      type: "OPEN_WORKSPACE_PAGE",
      label: localeText(params, "Open customers", "Abrir clientes"),
      requiresConfirmation: false,
      payload: { page: "customers" },
    });
  }
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [citations[0].label],
    customerId: customers[0]?.id ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: ["active quote relation count equals zero"],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "CUSTOMERS_WITHOUT_QUOTES",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "archived customers", "archived quotes"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "CUSTOMERS_WITHOUT_QUOTES",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: total ? null : "No active tenant customers were missing an active quote.",
        archivePolicy: "Only active customers and active quotes are considered.",
        filters: { total, limit, includeArchivedEffective: false },
      }),
    },
  };
}

async function runFollowUpQueue(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    return createDeniedCustomerToolResult(prisma, params, generatedAtUtc, "FOLLOW_UP_QUEUE");
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const normalizedFollowUpMessage = normalizeAssistantRoutingText(params.message);
  const quoteOnly = /\b(?:quotes?|estimates?|proposals?|cotizaci(?:on|ones)|presupuestos?|estimados?|propuestas?)\b/i.test(normalizedFollowUpMessage) &&
    /\b(?:not|never|haven't|havent|hasn't|hasnt|without|need|needs|due|pending|no|nunca|sin|necesita|necesitan|vencida|vencidas|pendiente|pendientes)\b/i.test(normalizedFollowUpMessage);
  const tenantId = params.access.tenantId;
  const activeCustomer = tenantActiveCustomerScope(tenantId);
  const activeQuote = tenantActiveQuoteScope(tenantId);
  const memberCustomer = assignedCustomerScope(params.access);
  const memberQuote = assignedQuoteScope(params.access);

  const [sentQuotes, afterSaleQuotes] = await Promise.all([
    prisma.quote.findMany({
      where: {
        ...activeQuote,
        ...memberQuote,
        status: "SENT_TO_CUSTOMER",
        customer: { is: { ...activeCustomer, ...memberCustomer, followUpStatus: "NEEDS_FOLLOW_UP" } },
      },
      orderBy: [{ sentAt: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        title: true,
        totalAmount: true,
        sentAt: true,
        updatedAt: true,
        customer: { select: { id: true, fullName: true, followUpStatus: true } },
      },
    }),
    quoteOnly
      ? Promise.resolve([])
      : prisma.quote.findMany({
          where: {
            ...activeQuote,
            ...memberQuote,
            status: "ACCEPTED",
            afterSaleFollowUpStatus: "DUE",
            afterSaleFollowUpDueAtUtc: { lte: generatedAtUtc },
            customer: { is: { ...activeCustomer, ...memberCustomer } },
          },
          orderBy: [{ afterSaleFollowUpDueAtUtc: "asc" }, { id: "asc" }],
          take: limit,
          select: {
            id: true,
            title: true,
            totalAmount: true,
            afterSaleFollowUpDueAtUtc: true,
            customer: { select: { id: true, fullName: true } },
          },
        }),
  ]);
  const remaining = Math.max(limit - sentQuotes.length - afterSaleQuotes.length, 0);
  const otherCustomers = quoteOnly || remaining === 0
    ? []
    : await prisma.customer.findMany({
        where: {
          ...activeCustomer,
          ...memberCustomer,
          followUpStatus: "NEEDS_FOLLOW_UP",
          quotes: {
            none: { ...activeQuote, ...memberQuote, status: { in: ["SENT_TO_CUSTOMER", "ACCEPTED"] } },
          },
        },
        orderBy: [{ followUpUpdatedAtUtc: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
        take: remaining,
        select: {
          id: true,
          fullName: true,
          followUpStatus: true,
          updatedAt: true,
          quotes: {
            where: { ...activeQuote, ...memberQuote },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { id: true, title: true, status: true, totalAmount: true },
          },
        },
      });

  const sentResults = sentQuotes.map((quote) => ({
      followUpType: "SENT_QUOTE",
      customerId: quote.customer.id,
      fullName: quote.customer.fullName,
      quoteId: quote.id,
      quoteTitle: quote.title,
      quoteStatus: "SENT_TO_CUSTOMER",
      quoteAmount: currency(quote.totalAmount),
      dueSinceUtc: (quote.sentAt ?? quote.updatedAt).toISOString(),
    }));
  const otherSalesResults = otherCustomers.map((customer) => {
      const quote = customer.quotes[0] ?? null;
      return {
        followUpType: quote ? "OPEN_QUOTE" : "NEW_CUSTOMER",
        customerId: customer.id,
        fullName: customer.fullName,
        quoteId: quote?.id ?? null,
        quoteTitle: quote?.title ?? null,
        quoteStatus: quote?.status ?? null,
        quoteAmount: currency(quote?.totalAmount),
        dueSinceUtc: customer.updatedAt.toISOString(),
      };
    });
  const afterSaleResults = afterSaleQuotes.map((quote) => ({
    followUpType: "AFTER_SALE",
    customerId: quote.customer.id,
    fullName: quote.customer.fullName,
    quoteId: quote.id,
    quoteTitle: quote.title,
    quoteStatus: "ACCEPTED",
    quoteAmount: currency(quote.totalAmount),
    dueSinceUtc: quote.afterSaleFollowUpDueAtUtc?.toISOString() ?? null,
  }));
  const results = quoteOnly
    ? sentResults.slice(0, limit)
    : [...sentResults, ...afterSaleResults, ...otherSalesResults].slice(0, limit);
  const displayedAfterSaleCount = results.filter((result) => result.followUpType === "AFTER_SALE").length;
  const displayedSalesCount = results.length - displayedAfterSaleCount;
  const answer = quoteOnly
    ? sentQuotes.length
      ? localeText(params, `Showing ${sentQuotes.length} sent quote${sentQuotes.length === 1 ? " that still needs" : "s that still need"} a sales follow-up. Oldest is shown first.`, `Se ${sentQuotes.length === 1 ? "muestra" : "muestran"} ${sentQuotes.length} cotización${sentQuotes.length === 1 ? " enviada que aún necesita" : "es enviadas que aún necesitan"} seguimiento de ventas. La más antigua aparece primero.`)
      : localeText(params, "No active sent quotes are currently marked as needing a sales follow-up.", "No hay cotizaciones enviadas activas marcadas para seguimiento de ventas.")
    : results.length
      ? localeText(params, `Showing ${displayedSalesCount} open sales follow-up${displayedSalesCount === 1 ? "" : "s"} and ${displayedAfterSaleCount} completed-job check-in${displayedAfterSaleCount === 1 ? "" : "s"} due now. Sales follow-ups are status-based and oldest-first because they do not yet have a separate due date.`, `Se muestran ${displayedSalesCount} seguimiento${displayedSalesCount === 1 ? "" : "s"} de ventas abierto${displayedSalesCount === 1 ? "" : "s"} y ${displayedAfterSaleCount} revisión${displayedAfterSaleCount === 1 ? "" : "es"} de trabajo terminado pendiente${displayedAfterSaleCount === 1 ? "" : "s"}. Los seguimientos de ventas se ordenan por estado y antigüedad porque todavía no tienen una fecha de vencimiento separada.`)
      : localeText(params, "No active sales follow-ups or due completed-job check-ins were found.", "No se encontraron seguimientos de ventas activos ni revisiones de trabajos terminados pendientes.");
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: quoteOnly
      ? localeText(params, "Active sent quotes awaiting follow-up", "Cotizaciones enviadas pendientes de seguimiento")
      : localeText(params, "Tenant follow-up queue", "Cola de seguimiento del espacio de trabajo"),
    sourceType: "Customer + Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const actions: AiAssistantAction[] = results.map((result) => ({
    type: "OPEN_CUSTOMER",
    label: localeText(params, `Open ${result.fullName}`, `Abrir a ${result.fullName}`),
    requiresConfirmation: false,
    payload: { customerId: result.customerId },
  }));
  actions.unshift({
    type: "OPEN_WORKSPACE_PAGE",
    label: localeText(params, "Open follow-up", "Abrir seguimiento"),
    requiresConfirmation: false,
    payload: { page: "follow-up" },
  });
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [citations[0].label],
    quoteId: results[0]?.quoteId ?? null,
    customerId: results[0]?.customerId ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: [quoteOnly ? "sent quote sales follow-up" : "sales and after-sale follow-up queue"],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "FOLLOW_UP_QUEUE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "archived customers", "archived quotes"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "FOLLOW_UP_QUEUE",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active follow-up rows matched the requested queue.",
        archivePolicy: "Only active customers and active quotes are considered.",
        filters: {
          quoteOnly,
          salesFollowUpCount: displayedSalesCount,
          afterSaleDueCount: displayedAfterSaleCount,
          dueAtOrBeforeUtc: generatedAtUtc.toISOString(),
          limit,
        },
      }),
    },
  };
}

function scenarioWinRate(message: string) {
  const match = normalizeAssistantRoutingText(message).match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|por\s+ciento)\b/i);
  const parsed = match ? Number(match[1]) : 30;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : 30;
}

async function runPipelineScenario(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const tenantId = params.access.tenantId;
  const winRatePercent = scenarioWinRate(params.message);
  const referenceFromUtc = new Date(generatedAtUtc.getTime() - (90 * 24 * 60 * 60 * 1_000));
  const serviceFilter = params.context?.serviceType ? { serviceType: params.context.serviceType } : {};
  const [open, accepted] = await Promise.all([
    prisma.quote.aggregate({
      where: {
        ...tenantActiveQuoteScope(tenantId),
        ...assignedQuoteScope(params.access),
        status: { in: [...OPEN_PIPELINE_STATUSES] },
        ...serviceFilter,
      },
      _count: { _all: true },
      _sum: { customerPriceSubtotal: true },
    }),
    prisma.quote.aggregate({
      where: {
        ...tenantActiveQuoteScope(tenantId),
        ...assignedQuoteScope(params.access),
        status: "ACCEPTED",
        closedAtUtc: { gte: referenceFromUtc, lte: generatedAtUtc },
        ...serviceFilter,
      },
      _count: { _all: true },
      _sum: { customerPriceSubtotal: true },
    }),
  ]);
  const openPipelineRevenue = roundCurrency(Number(open._sum.customerPriceSubtotal ?? 0));
  const acceptedRevenueLast90Days = roundCurrency(Number(accepted._sum.customerPriceSubtotal ?? 0));
  const scenarioRevenue = roundCurrency(openPipelineRevenue * (winRatePercent / 100));
  const revenueBoostPercent = acceptedRevenueLast90Days > 0
    ? Number(((scenarioRevenue / acceptedRevenueLast90Days) * 100).toFixed(1))
    : null;
  const projectedRevenue = roundCurrency(acceptedRevenueLast90Days + scenarioRevenue);
  const locale = assistantLocale(params);
  const results = [{
    openQuoteCount: open._count._all,
    openPipelineRevenue,
    assumedWinRatePercent: winRatePercent,
    scenarioRevenue,
    acceptedQuoteCountLast90Days: accepted._count._all,
    acceptedRevenueLast90Days,
    revenueBoostPercent,
    projectedRevenueWithScenario: projectedRevenue,
  }];
  const answer = open._count._all
    ? acceptedRevenueLast90Days > 0
      ? localeText(params, `Your active open quote subtotal is ${money(openPipelineRevenue)} across ${open._count._all} quotes. Closing ${winRatePercent}% would add about ${money(scenarioRevenue)}—a ${revenueBoostPercent}% lift over the ${money(acceptedRevenueLast90Days)} accepted in the last 90 days, for about ${money(projectedRevenue)} combined.`, `El subtotal de tus cotizaciones abiertas activas es ${money(openPipelineRevenue, locale)} en ${open._count._all} cotizaciones. Cerrar el ${winRatePercent}% agregaría aproximadamente ${money(scenarioRevenue, locale)}: un aumento de ${revenueBoostPercent}% sobre los ${money(acceptedRevenueLast90Days, locale)} aceptados en los últimos 90 días, para un total aproximado de ${money(projectedRevenue, locale)}.`)
      : localeText(params, `Your active open quote subtotal is ${money(openPipelineRevenue)} across ${open._count._all} quotes. Closing ${winRatePercent}% would add about ${money(scenarioRevenue)}. There is no accepted revenue in the last 90 days, so a meaningful percentage lift cannot be calculated yet.`, `El subtotal de tus cotizaciones abiertas activas es ${money(openPipelineRevenue, locale)} en ${open._count._all} cotizaciones. Cerrar el ${winRatePercent}% agregaría aproximadamente ${money(scenarioRevenue, locale)}. No hay ingresos aceptados en los últimos 90 días, así que todavía no se puede calcular un aumento porcentual útil.`)
    : localeText(params, "There are no active open quotes to model right now.", "No hay cotizaciones abiertas activas para calcular este escenario.");
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: localeText(params, "Tenant quote revenue aggregates", "Totales de ingresos por cotizaciones del espacio de trabajo"),
    sourceType: "Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Quote"],
    sourceLabels: [citations[0].label],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: [
      `winRatePercent=${winRatePercent}`,
      "active open quote customerPriceSubtotal aggregate",
      "accepted quote 90-day closedAtUtc aggregate",
    ],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PIPELINE_SCENARIO",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions: [{
        type: "OPEN_ANALYTICS",
        label: localeText(params, "Open analytics", "Abrir análisis"),
        requiresConfirmation: false,
        payload: { winRatePercent, referenceFromUtc: referenceFromUtc.toISOString() },
      }],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PIPELINE_SCENARIO",
        resultCount: 1,
        citationCount: citations.length,
        emptyReason: open._count._all ? null : "No active open quotes matched tenant scope.",
        archivePolicy: "Archived and deleted quotes are excluded from both aggregates.",
        filters: {
          openStatuses: OPEN_PIPELINE_STATUSES.join(","),
          serviceType: params.context?.serviceType,
          acceptedReferenceFromUtc: referenceFromUtc.toISOString(),
          acceptedReferenceToUtc: generatedAtUtc.toISOString(),
          winRatePercent,
        },
      }),
    },
  };
}

function businessToolForProfitPrompt(message: string): AiBusinessInsightTool {
  return /\b(item|items|product|products|material|materials|line[-\s]*items?|articulo|articulos|producto|productos|material|materiales|partida|partidas)\b/i.test(normalizeAssistantRoutingText(message))
    ? "ITEM_PROFITABILITY"
    : "SERVICE_PROFITABILITY";
}

function spanishBusinessInsightAnswer(
  insight: Awaited<ReturnType<typeof generateAiBusinessInsight>>,
) {
  const locale: SupportedLocale = "es-US";
  const from = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(insight.dateRange.from);
  const to = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(insight.dateRange.to);
  if (insight.tool === "SALES_PIPELINE") {
    const winRate = insight.summary.winRatePercent === null
      ? ""
      : ` La tasa de cierre es ${insight.summary.winRatePercent}%.`;
    return `Pipeline de ventas del ${from} al ${to}: ${insight.summary.quoteCount} cotización${insight.summary.quoteCount === 1 ? "" : "es"}. Los ingresos aceptados son ${money(insight.summary.acceptedRevenue, locale)} y el pipeline abierto es ${money(insight.summary.pipelineRevenue, locale)}.${winRate}`;
  }
  const top = insight.rows[0];
  if (insight.tool === "ITEM_PROFITABILITY") {
    const item = typeof top?.item === "string" ? top.item : null;
    const grossProfit = typeof top?.grossProfit === "number" ? top.grossProfit : null;
    const margin = typeof top?.grossMarginPercent === "number" ? top.grossMarginPercent : null;
    return item && grossProfit !== null
      ? `Rentabilidad por producto del ${from} al ${to}: se ordenaron ${insight.rows.length} grupo${insight.rows.length === 1 ? "" : "s"}. El producto principal es ${item}, con ${money(grossProfit, locale)} de ganancia bruta${margin === null ? "" : ` y ${margin}% de margen`}.`
      : `No se encontraron productos de cotizaciones aceptadas en el periodo del ${from} al ${to}.`;
  }
  const serviceType = typeof top?.serviceType === "string" ? top.serviceType : null;
  const topGrossProfit = typeof top?.grossProfit === "number" ? top.grossProfit : null;
  return serviceType && topGrossProfit !== null
    ? `Rentabilidad por servicio del ${from} al ${to}: ${serviceType} ocupa el primer lugar con ${money(topGrossProfit, locale)} de ganancia bruta. En total, los ingresos aceptados son ${money(insight.summary.acceptedRevenue, locale)} y la ganancia bruta es ${money(insight.summary.grossProfit ?? 0, locale)}${insight.summary.grossMarginPercent == null ? "." : `, con un margen de ${insight.summary.grossMarginPercent}%.`}`
    : `No se encontraron cotizaciones aceptadas para calcular la rentabilidad en el periodo del ${from} al ${to}.`;
}

async function createDeniedFinancialAudit(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
) {
  const answer = localeText(params, "Profitability ranking uses internal costs and margins. Ask an owner or admin to run this, or use pipeline summary for revenue-only insights.", "La clasificación de rentabilidad usa costos internos y márgenes. Pide a un propietario o administrador que la ejecute, o usa el resumen del pipeline para ver solo ingresos.");
  const governedPrompt = governAiPrompt(params.message, {
    knownSensitiveValues: [
      params.actor.actorEmail,
      params.actor.actorName,
    ].filter((value): value is string => Boolean(value?.trim())),
  });
  const retrievalAudit = await withTenantRlsContext(prisma, params.access.tenantId, (tx) => tx.aiRetrievalAuditEvent.create({
    data: {
      tenant: { connect: { id: params.access.tenantId } },
      ...(params.actor.actorUserId ? { actorUser: { connect: { id: params.actor.actorUserId } } } : {}),
      requestId: params.access.requestId.slice(0, 128),
      purpose: "BUSINESS_INSIGHT",
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
      sourceTypes: ["Quote", "QuoteLineItem"],
      sourceRefs: Prisma.JsonNull,
      resultCount: 0,
      queryHash: governedPrompt.sha256,
      policyVersion: AI_DATA_POLICY_VERSION,
      status: "DENIED",
      denialCode: "MISSING_FINANCIAL_CAPABILITY",
      retentionExpiresAtUtc: governedPrompt.retentionExpiresAtUtc,
    },
  }));
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C3_FINANCIAL_CONFIDENTIAL",
    sourceTypes: ["Quote", "QuoteLineItem"],
    sourceLabels: ["Profitability insight denied"],
    creditsConsumed: 0,
    retrievalAuditEventId: retrievalAudit.id,
    riskNote: "Denied before C3 financial aggregate retrieval because the actor lacks margin/cost capabilities.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "RANK_PROFITABLE_JOBS" as const,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification,
      answer,
      results: [],
      citations: [{ key: "A1", label: localeText(params, "Profitability insight denied", "Acceso a rentabilidad denegado"), sourceType: "Quote", classification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification }],
      actions: [{ type: "REQUEST_ADMIN_ACCESS" as const, label: localeText(params, "Ask an admin for profitability access", "Solicitar acceso a rentabilidad"), requiresConfirmation: true, payload: { capabilities: ["viewInternalCosts", "viewMargins"] } }],
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "internal cost aggregates", "margin aggregates"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "RANK_PROFITABLE_JOBS",
        resultCount: 0,
        citationCount: 1,
        emptyReason: "Profitability retrieval denied before C3 financial aggregate access.",
        archivePolicy: "No quote rows are retrieved when profitability access is denied.",
        filters: {
          currentPage: params.context?.currentPage,
          includeArchivedRequested: Boolean(params.context?.includeArchived),
          includeArchivedEffective: false,
        },
      }),
    },
  };
}

async function runBusinessInsightTool(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "SUMMARIZE_PIPELINE" | "RANK_PROFITABLE_JOBS",
): Promise<AiAssistantRunResult> {
  const businessTool: AiBusinessInsightTool =
    tool === "SUMMARIZE_PIPELINE" ? "SALES_PIPELINE" : businessToolForProfitPrompt(params.message);
  const inferredRange = inferAssistantRelativeDateRange(params.message, generatedAtUtc);

  try {
    const insight = await generateAiBusinessInsight(prisma, {
      access: params.access,
      actor: params.actor,
      prompt: params.message,
      tool: businessTool,
      dateFrom: params.context?.dateFrom ?? inferredRange?.from ?? null,
      dateTo: params.context?.dateTo ?? inferredRange?.to ?? null,
      serviceType: params.context?.serviceType ?? null,
      limit: params.context?.limit,
      includeArchived: params.context?.includeArchived,
      now: generatedAtUtc,
      sensitiveValues: [params.message],
      conversation: params.conversation,
    });

    return {
      consumedCredits: 1,
      consumedSpendUsd: insight.telemetry?.estimatedCostUsd ?? 0,
      assistant: {
        tool,
        generatedAtUtc,
        policyVersion: insight.policyVersion,
        maxClassification: insight.maxClassification,
        answer: isSpanishAssistant(params) ? spanishBusinessInsightAnswer(insight) : insight.answer,
        results: insight.rows.map((row) => ({ ...row })),
        citations: insight.citations,
        actions: [{
          type: "OPEN_ANALYTICS",
          label: tool === "SUMMARIZE_PIPELINE"
            ? localeText(params, "Open analytics", "Abrir análisis")
            : localeText(params, "Review profitability", "Revisar rentabilidad"),
          requiresConfirmation: false,
          payload: {
            insightTool: businessTool,
            dateFrom: insight.dateRange.from.toISOString(),
            dateTo: insight.dateRange.to.toISOString(),
            serviceType: insight.filters.serviceType,
          },
        }],
        auditEventId: insight.auditEventId,
        fieldsExcluded: insight.fieldsExcluded,
        diagnostics: {
          ...diagnostics({
            input: params,
            resolvedTool: tool,
            resultCount: insight.rows.length,
            citationCount: insight.citations.length,
            emptyReason: insight.rows.length ? null : "No active quote aggregates matched tenant scope and effective filters.",
            archivePolicy: insight.filters.includeArchived
              ? "Archived quote aggregates were included because the current role policy allowed it."
              : "Archived/deleted quote aggregates were excluded by the current role policy.",
            filters: {
              currentPage: params.context?.currentPage,
              businessInsightTool: businessTool,
              dateField: "Quote.createdAt",
              dateFrom: insight.dateRange.from.toISOString(),
              dateTo: insight.dateRange.to.toISOString(),
              serviceType: insight.filters.serviceType,
              limit: params.context?.limit ?? null,
              includeArchivedRequested: Boolean(params.context?.includeArchived),
              includeArchivedEffective: insight.filters.includeArchived,
            },
          }),
          answerMode: insight.answerMode,
          model: insight.model,
        },
      },
    };
  } catch (error) {
    if (error instanceof AiBusinessInsightForbiddenError && tool === "RANK_PROFITABLE_JOBS") {
      return createDeniedFinancialAudit(prisma, params, generatedAtUtc);
    }
    throw error;
  }
}

function quotePromptForParser(message: string) {
  const normalized = normalizeAssistantRoutingText(message);
  if (!/\b(?:cotizacion|presupuesto|estimado|propuesta|techo|techado|piso|plomeria|jardineria|paisajismo|construccion|cliente|pies?\s+cuadrados?)\b/i.test(normalized)) {
    return message;
  }
  return normalized
    .replace(/\b(?:nueva\s+)?(?:cotizacion|presupuesto|estimado|propuesta)\s+para\s+(?:el\s+|la\s+)?cliente\s+/gi, "quote for ")
    .replace(/\b(?:nueva\s+)?(?:cotizacion|presupuesto|estimado|propuesta)\s+para\s+/gi, "quote for ")
    .replace(/\b(?:cotizacion|presupuesto|estimado|propuesta)\b/gi, "quote")
    .replace(/\b(?:reparacion|reemplazo|instalacion)\s+(?:de|del)\s+techo\b/gi, "roofing repair")
    .replace(/\b(?:techo|techado)\b/gi, "roofing")
    .replace(/\b(?:instalacion\s+de\s+)?pisos?\b/gi, "flooring")
    .replace(/\bplomeria\b/gi, "plumbing")
    .replace(/\b(?:jardineria|paisajismo)\b/gi, "landscaping")
    .replace(/\bconstruccion\b/gi, "construction")
    .replace(/\b(\d[\d,.]*)\s+pies?\s+cuadrados?\b/gi, "$1 square feet")
    .replace(/\b(?:aproximadamente|alrededor\s+de|cerca\s+de)\b/gi, "about")
    .replace(/\b(?:precio|total|costo\s+al\s+cliente)\s+(?:es|de|sera|seria)?\s*/gi, "total ")
    .replace(/\b(?:costo\s+interno|nuestro\s+costo)\s+(?:es|de|sera|seria)?\s*/gi, "internal cost ");
}

function quotePromptForConversation(params: AiAssistantInput) {
  const currentPrompt = quotePromptForParser(params.message);
  const quoteNounPattern = /\b(?:quote|estimate|bid|proposal|cotizacion|presupuesto|estimado|propuesta)\b/i;
  const quoteTurns = (params.conversation ?? [])
    .filter((turn) => turn.resolvedTool === "DRAFT_QUOTE")
    .map((turn) => quotePromptForParser(turn.message.slice(0, 500)));
  if (!quoteTurns.length || quoteNounPattern.test(currentPrompt)) {
    return currentPrompt;
  }

  let latestQuoteAnchorIndex = -1;
  for (let index = quoteTurns.length - 1; index >= 0; index -= 1) {
    if (!quoteNounPattern.test(quoteTurns[index] ?? "")) continue;
    latestQuoteAnchorIndex = index;
    break;
  }
  const retainedTurns = quoteTurns.slice(Math.max(0, latestQuoteAnchorIndex));
  let mergedPrompt = retainedTurns.shift() ?? "";

  for (const reply of [...retainedTurns, currentPrompt]) {
    const normalizedReply = normalizeAssistantRoutingText(reply);
    if (!normalizedReply) continue;
    const accumulatedDraft = parseChatToQuotePrompt(mergedPrompt);
    const needsCustomerName = !accumulatedDraft.customerName;
    const isShortEntityReply = CONTEXTUAL_ENTITY_QUERY_PATTERN.test(normalizedReply);
    const isDirectContactReply = CUSTOMER_DRAFT_DETAIL_PATTERN.test(normalizedReply);
    const retainedReply = needsCustomerName && isShortEntityReply && !isDirectContactReply
      ? `customer ${normalizedReply}`
      : normalizedReply;
    const priorPrompt = mergedPrompt.trimEnd();
    mergedPrompt = priorPrompt
      ? `${priorPrompt}${/[.!?;:,]$/.test(priorPrompt) ? "" : "."}\n${retainedReply}`
      : retainedReply;
  }

  return mergedPrompt;
}

function spanishQuoteTitle(serviceType: ServiceCategory) {
  if (serviceType === "ROOFING") return "Cotización de techado";
  if (serviceType === "HVAC") return "Cotización de HVAC";
  if (serviceType === "PLUMBING") return "Cotización de plomería";
  if (serviceType === "FLOORING") return "Cotización de pisos";
  if (serviceType === "GARDENING") return "Cotización de jardinería y paisajismo";
  return "Cotización de construcción";
}

function spanishTradeName(serviceType: ServiceCategory) {
  if (serviceType === "ROOFING") return "techado";
  if (serviceType === "HVAC") return "HVAC";
  if (serviceType === "PLUMBING") return "plomería";
  if (serviceType === "FLOORING") return "pisos";
  if (serviceType === "GARDENING") return "jardinería y paisajismo";
  return "construcción";
}

async function runDraftQuotePreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "useAiQuoteDrafting")) {
    const answer = localeText(params, "AI quote drafting is not enabled for this role.", "La preparación de cotizaciones con IA no está habilitada para este rol.");
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Quote"],
      sourceLabels: ["Quote drafting denied"],
      creditsConsumed: 0,
      riskNote: "Denied before quote drafting preview because the actor lacks useAiQuoteDrafting.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "DRAFT_QUOTE",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: localeText(params, "Ask an admin for AI quote drafting", "Solicitar acceso para preparar cotizaciones con IA"), requiresConfirmation: true, payload: { capability: "useAiQuoteDrafting" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "DRAFT_QUOTE",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Quote drafting denied before prompt parsing because the role lacks AI quote drafting access.",
          archivePolicy: "No quote rows are retrieved when quote drafting access is denied.",
          filters: {
            currentPage: params.context?.currentPage,
            scopedCustomer: Boolean(params.context?.customerId),
            scopedQuote: Boolean(params.context?.quoteId),
            includeArchivedRequested: Boolean(params.context?.includeArchived),
            includeArchivedEffective: false,
          },
        }),
      },
    };
  }

  const selectedQuote = params.context?.quoteId
    ? await prisma.quote.findFirst({
        where: {
          id: params.context.quoteId,
          ...tenantActiveQuoteScope(params.access.tenantId),
          ...assignedQuoteScope(params.access),
        },
        select: {
          id: true,
          title: true,
          scopeText: true,
          serviceType: true,
          customerId: true,
          customer: {
            select: { id: true, fullName: true, email: true, phone: true },
          },
        },
      })
    : null;
  const parserPrompt = quotePromptForConversation(params);
  const draft = parseChatToQuotePrompt(parserPrompt);
  const selectedCustomerId = params.context?.customerId ?? selectedQuote?.customerId ?? null;
  const scopedCustomer = selectedQuote?.customer ?? (selectedCustomerId
    ? await prisma.customer.findFirst({
        where: {
          id: selectedCustomerId,
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
        },
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : null);
  const parsedPhoneDigits = draft.customerPhone
    ? normalizeUsPhoneDigits(draft.customerPhone) ?? normalizePhoneSearchDigits(draft.customerPhone)
    : null;
  const exactContactMatches = !scopedCustomer && (draft.customerEmail || parsedPhoneDigits)
    ? await prisma.customer.findMany({
        where: {
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
          OR: [
            ...(draft.customerEmail ? [{ email: { equals: draft.customerEmail, mode: "insensitive" as const } }] : []),
            ...(parsedPhoneDigits ? [{ phoneDigits: parsedPhoneDigits }] : []),
          ],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 4,
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : [];
  const exactNameMatches = !scopedCustomer && exactContactMatches.length === 0 && draft.customerName
    ? await prisma.customer.findMany({
        where: {
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
          fullName: { equals: draft.customerName, mode: "insensitive" },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 4,
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : [];
  const partialNameMatches = !scopedCustomer
    && exactContactMatches.length === 0
    && exactNameMatches.length === 0
    && draft.customerName
    ? await prisma.customer.findMany({
        where: {
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
          fullName: { contains: draft.customerName, mode: "insensitive" },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 4,
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : [];
  const customerCandidates = exactContactMatches.length
    ? exactContactMatches
    : exactNameMatches.length
      ? exactNameMatches
      : partialNameMatches;
  const selectedCustomer = scopedCustomer ?? (customerCandidates.length === 1 ? customerCandidates[0] : null);
  const serviceType = params.context?.serviceType ?? selectedQuote?.serviceType ?? draft.serviceType;
  const title = selectedQuote?.title || (isSpanishAssistant(params) ? spanishQuoteTitle(serviceType) : draft.title);
  const scopeText = selectedQuote?.scopeText || parserPrompt;

  const missingCustomer = !scopedCustomer && !draft.customerName && !draft.customerEmail && !draft.customerPhone;
  const unmatchedCustomerNeedsName = !scopedCustomer && customerCandidates.length === 0
    && Boolean(draft.customerEmail || draft.customerPhone) && !draft.customerName;
  const unmatchedCustomerNeedsPhone = !scopedCustomer && customerCandidates.length === 0
    && Boolean(draft.customerName || draft.customerEmail) && !draft.customerPhone;
  const missingWork = !selectedQuote && !QUOTE_WORK_DETAIL_PATTERN.test(parserPrompt);
  if (missingCustomer || unmatchedCustomerNeedsName || unmatchedCustomerNeedsPhone || missingWork) {
    const answer = missingCustomer
      ? localeText(
          params,
          "Who is this quote for? Reply with the customer name, email, or phone number. I'll keep the job details from this request.",
          "¿Para quién es esta cotización? Responde con el nombre, correo o teléfono del cliente. Conservaré los detalles del trabajo de esta solicitud.",
        )
      : unmatchedCustomerNeedsName
        ? localeText(
            params,
            "I could not find an active assigned customer with those contact details. Reply with the customer's name to prepare a new linked customer and keep this quote draft.",
            "No encontré un cliente activo asignado con esos datos de contacto. Responde con el nombre del cliente para preparar un cliente nuevo vinculado y conservar este borrador.",
          )
        : unmatchedCustomerNeedsPhone
          ? localeText(
              params,
              `I could not find an active assigned customer${draft.customerName ? ` named ${draft.customerName}` : ""}. Reply with the phone number to prepare a new linked customer, or provide a different email or phone to search again. I'll keep the quote details.`,
              `No encontré un cliente activo asignado${draft.customerName ? ` llamado ${draft.customerName}` : ""}. Responde con el teléfono para preparar un cliente nuevo vinculado, o proporciona otro correo o teléfono para buscar de nuevo. Conservaré los detalles de la cotización.`,
            )
          : localeText(
              params,
              "What work should this quote cover? Reply with the trade and job, product, or service. I'll keep the customer from this request.",
              "¿Qué trabajo debe incluir esta cotización? Responde con el oficio y el trabajo, producto o servicio. Conservaré el cliente de esta solicitud.",
            );
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Quote"],
      sourceLabels: ["Quote drafting clarification"],
      customerId: scopedCustomer?.id ?? null,
      quoteId: selectedQuote?.id ?? null,
      serviceType,
      creditsConsumed: 0,
      riskNote: "Requested a missing quote input before provider retrieval or draft creation.",
    });
    const clarificationDiagnostics = diagnostics({
      input: params,
      resolvedTool: "DRAFT_QUOTE",
      resultCount: 0,
      citationCount: 0,
      emptyReason: missingCustomer
        ? "Customer identity is required to prepare the review draft."
        : unmatchedCustomerNeedsName || unmatchedCustomerNeedsPhone
          ? "No active assigned customer matched and required new-customer details are incomplete."
          : "Work details are required to prepare the review draft.",
      archivePolicy: "No customer, quote, or catalog rows are retrieved until the missing prompt detail is supplied.",
      filters: {
        currentPage: params.context?.currentPage,
        scopedCustomer: Boolean(selectedCustomerId),
        scopedQuote: Boolean(params.context?.quoteId),
        includeArchivedRequested: Boolean(params.context?.includeArchived),
        includeArchivedEffective: false,
      },
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "DRAFT_QUOTE",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: clarificationDiagnostics,
      },
    };
  }

  const mayViewInternalCost = hasCapability(params.access, "viewInternalCosts");
  const providerBudget = createAiQuoteProviderBudget();
  const preparedCatalog = await prepareCatalogQuoteLines(prisma, {
    tenantId: params.access.tenantId,
    serviceType,
    prompt: parserPrompt,
    parsedLines: draft.lineItems,
    estimatedDurationHoursHigh: draft.estimatedDurationHoursHigh,
    includeInternalCost: mayViewInternalCost,
  });
  let governedRetrieval: AiRetrievalResult | null = null;
  let retrievalDegraded = false;
  const retrievalEnabled = isAiRagEnabledForTenant(env, params.access.tenantId);
  const retrievalExposed = isAiRagExposedForTenant(env, params.access.tenantId);
  try {
    governedRetrieval = await buildGovernedQuoteAiContext(prisma, {
      access: params.access,
      query: parserPrompt,
      purpose: selectedQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
      serviceType,
      requestId: params.access.requestId,
      customerId: selectedCustomer?.id ?? null,
      quoteId: selectedQuote?.id ?? null,
      priorUserQueries: params.conversation
        ?.filter((turn) => turn.resolvedTool === "DRAFT_QUOTE")
        .map((turn) => turn.message),
      refreshIndex: Boolean(selectedQuote || selectedCustomer),
      allowProviderCalls: false,
    });
  } catch (error) {
    if (error instanceof AiUsageLedgerError) throw error;
    retrievalDegraded = true;
    // Retrieval is additive. Kody still returns a review-only deterministic
    // preview when indexing or the embedding provider is temporarily unavailable.
  }
  const includeInternalCost = mayViewInternalCost && (
    draft.estimatedInternalCostAmount !== null
    || preparedCatalog.lines.some((lineItem) => lineItem.unitCost !== null)
  );
  const promptClassification: DataClassification = includeInternalCost ? "C3_FINANCIAL_CONFIDENTIAL" : "C2_CUSTOMER_CONFIDENTIAL";
  const retrievalClassification = governedRetrieval?.chunks.reduce<DataClassification>(
    (current, chunk) => highestClassification(current, chunk.classification),
    "C0_PUBLIC",
  ) ?? "C0_PUBLIC";
  const maxClassification = highestClassification(promptClassification, retrievalClassification);
  const retrievedSourceCount = governedRetrieval?.citations.length ?? 0;
  const catalogMatchedCount = preparedCatalog.lines.filter((lineItem) => lineItem.catalogMatched).length;
  const localizedTradeName = isSpanishAssistant(params)
    ? spanishTradeName(serviceType)
    : serviceType.toLowerCase();
  const answer = customerCandidates.length > 1
    ? localeText(params, `I found ${customerCandidates.length} active assigned customers matching ${draft.customerName ?? "those contact details"}. Choose the correct customer before opening the review draft.`, `Encontré ${customerCandidates.length} clientes activos asignados que coinciden con ${draft.customerName ?? "esos datos de contacto"}. Elige al cliente correcto antes de abrir el borrador para revisión.`)
    : retrievedSourceCount
    ? localeText(params, `Prepared a priced ${localizedTradeName} review draft for ${title} using ${catalogMatchedCount} saved catalog item${catalogMatchedCount === 1 ? "" : "s"} and ${retrievedSourceCount} relevant workspace source${retrievedSourceCount === 1 ? "" : "s"}. Review the scope and pricing before saving or sending.`, `Preparé un borrador con precios de ${localizedTradeName} para revisar: ${title}, usando ${catalogMatchedCount} elemento${catalogMatchedCount === 1 ? "" : "s"} guardado${catalogMatchedCount === 1 ? "" : "s"} del catálogo y ${retrievedSourceCount} fuente${retrievedSourceCount === 1 ? " relevante" : "s relevantes"} del espacio de trabajo. Revisa el alcance y los precios antes de guardar o enviar.`)
    : !selectedCustomer
      ? localeText(params, `Prepared a ${localizedTradeName} review draft with ${catalogMatchedCount} saved catalog item${catalogMatchedCount === 1 ? "" : "s"}. I could not match an active assigned customer, so add or select the customer before saving.`, `Preparé un borrador de ${localizedTradeName} para revisar con ${catalogMatchedCount} elemento${catalogMatchedCount === 1 ? "" : "s"} guardado${catalogMatchedCount === 1 ? "" : "s"} del catálogo. No pude encontrar un cliente activo asignado, así que agrega o selecciona el cliente antes de guardar.`)
      : localeText(params, `Prepared a priced ${localizedTradeName} review draft for ${title} with ${catalogMatchedCount} saved catalog item${catalogMatchedCount === 1 ? "" : "s"}. Review the scope and pricing before saving or sending.`, `Preparé un borrador con precios de ${localizedTradeName} para revisar: ${title}, con ${catalogMatchedCount} elemento${catalogMatchedCount === 1 ? "" : "s"} guardado${catalogMatchedCount === 1 ? "" : "s"} del catálogo. Revisa el alcance y los precios antes de guardar o enviar.`);
  const results = [{
    title,
    serviceType,
    customerName: selectedCustomer?.fullName ?? draft.customerName ?? null,
    squareFeetEstimate: draft.squareFeetEstimate,
    estimatedTotalAmount: draft.estimatedTotalAmount,
    estimatedTaxAmount: draft.estimatedTaxAmount,
    estimatedInternalCostAmount: includeInternalCost ? draft.estimatedInternalCostAmount : null,
    estimatedDurationHoursLow: draft.estimatedDurationHoursLow,
    estimatedDurationHoursHigh: draft.estimatedDurationHoursHigh,
    lineItemCount: preparedCatalog.lines.length,
    catalogMatchedCount,
  }];
  const citations: AiAssistantCitation[] = [
    { key: "A1", label: localeText(params, "Parsed quote drafting prompt", "Solicitud analizada para preparar la cotización"), sourceType: "Quote", classification: promptClassification },
    ...preparedCatalog.matchedPresetLabels.map((label, index) => ({
      key: `P${index + 1}`,
      label,
      sourceType: "WorkPreset",
      classification: includeInternalCost
        ? "C3_FINANCIAL_CONFIDENTIAL" as const
        : "C1_BUSINESS_INTERNAL" as const,
    })),
    ...(governedRetrieval?.citations.map((citation) => ({
      key: citation.key,
      label: citation.label,
      sourceType: citation.sourceType,
      classification: citation.classification,
    })) ?? []),
  ];
  const baseActionPayload = {
      prompt: parserPrompt,
      customerId: selectedCustomer?.id ?? null,
      customerName: selectedCustomer?.fullName ?? draft.customerName ?? null,
      customerEmail: selectedCustomer?.email ?? draft.customerEmail ?? null,
      customerPhone: selectedCustomer?.phone ?? draft.customerPhone ?? null,
      quoteId: selectedQuote?.id ?? null,
      serviceType,
      title,
      scopeText,
      squareFeetEstimate: draft.squareFeetEstimate,
      squareFeetEstimateLow: draft.squareFeetEstimateLow,
      squareFeetEstimateHigh: draft.squareFeetEstimateHigh,
      estimatedTotalAmount: draft.estimatedTotalAmount,
      estimatedTaxAmount: draft.estimatedTaxAmount,
      estimatedInternalCostAmount: includeInternalCost ? draft.estimatedInternalCostAmount : null,
      estimatedDurationHoursLow: draft.estimatedDurationHoursLow,
      estimatedDurationHoursHigh: draft.estimatedDurationHoursHigh,
      lineItems: preparedCatalog.lines.map((lineItem) => ({
        description: lineItem.description,
        quantity: lineItem.quantity,
        sectionType: lineItem.sectionType,
        sectionLabel: lineItem.sectionLabel,
        sourcePresetId: lineItem.sourcePresetId,
        unitType: lineItem.unitType,
        unitPrice: lineItem.unitPrice,
        ...(includeInternalCost ? { unitCost: lineItem.unitCost } : {}),
      })),
      useWorkspaceContext: retrievedSourceCount > 0 || catalogMatchedCount > 0,
      retrievedSourceCount: retrievedSourceCount + catalogMatchedCount,
      retrievedSourceLabels: Array.from(
        new Set([
          ...preparedCatalog.matchedPresetLabels,
          ...(governedRetrieval?.citations.map((citation) => citation.label) ?? []),
        ]),
      ).slice(0, 6),
  };
  const actions: AiAssistantAction[] = customerCandidates.length > 1
    ? customerCandidates.slice(0, 3).map((customer, index) => {
        const contactLabel = customer.email || customer.phone || `match ${index + 1}`;
        return {
          type: "OPEN_QUOTE_DRAFT",
          label: localeText(params, `Draft for ${customer.fullName} · ${contactLabel}`, `Borrador para ${customer.fullName} · ${contactLabel}`),
          requiresConfirmation: true,
          payload: {
            ...baseActionPayload,
            customerId: customer.id,
            customerName: customer.fullName,
            customerEmail: customer.email,
            customerPhone: customer.phone,
          },
        };
      })
    : [{
        type: "OPEN_QUOTE_DRAFT",
        label: localeText(params, "Review quote draft", "Revisar borrador de la cotización"),
        requiresConfirmation: true,
        payload: baseActionPayload,
      }];
  const fieldsExcluded = [
    ...defaultExcludedFields(includeInternalCost),
    ...(includeInternalCost ? [] : ["user-supplied internal cost estimate"]),
  ];
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "DRAFT_QUOTE",
    resultCount: 1,
    citationCount: citations.length,
    emptyReason: selectedCustomer || selectedQuote ? null : "No active assigned customer matched; the draft contains an unconfirmed customer form.",
    archivePolicy: "Quote drafting context uses active tenant customers and quotes only.",
    filters: {
      currentPage: params.context?.currentPage,
      scopedCustomer: Boolean(selectedCustomerId),
      selectedCustomerFound: Boolean(selectedCustomer),
      scopedQuote: Boolean(params.context?.quoteId),
      selectedQuoteFound: Boolean(selectedQuote),
      includeArchivedRequested: Boolean(params.context?.includeArchived),
      includeArchivedEffective: false,
      retrievedSourceCount,
      catalogMatchedCount,
      retrievalEnabled,
      retrievalExposed,
      retrievalDegraded,
    },
  });
  const composition = await composeAssistantAnswer({
    diagnosticContext: { requestId: params.access.requestId },
    userMessage: parserPrompt,
    tool: "DRAFT_QUOTE",
    deterministicAnswer: answer,
    maxClassification,
    results,
    citations,
    actions: actions.map((action, index) => ({
      ...action,
      label: customerCandidates.length > 1
        ? localeText(params, `Review customer match ${index + 1}`, `Revisar coincidencia de cliente ${index + 1}`)
        : action.label,
    })),
    fieldsExcluded,
    diagnostics: baseDiagnostics,
    sensitiveValues: [
      params.actor.actorEmail,
      params.actor.actorName,
      draft.customerName,
      draft.customerEmail,
      draft.customerPhone,
      selectedCustomer?.fullName,
      selectedCustomer?.email,
      selectedCustomer?.phone,
    ],
    conversation: params.conversation,
    preferredLocale: assistantLocale(params),
    retrievalExcerpts: governedRetrieval?.chunks.map((chunk) => ({
      key: chunk.citationKey,
      label: chunk.citationLabel,
      sourceType: chunk.sourceType,
      sourceField: chunk.sourceField,
      classification: chunk.classification,
      content: chunk.content,
    })),
    providerBudget,
  });
  const combinedTelemetry = mergeAiUsageTelemetry(governedRetrieval?.telemetry, composition.telemetry);
  const sourceTypes = Array.from(new Set([
    "Quote",
    ...(selectedCustomer ? ["Customer"] : []),
    ...(catalogMatchedCount ? ["WorkPreset"] : []),
    ...(governedRetrieval?.citations.map((citation) => citation.sourceType) ?? []),
  ]));
  const sourceLabels = Array.from(new Set([
    selectedQuote
      ? "Selected active quote"
      : selectedCustomer
        ? "Selected active customer"
        : "Preview quote draft",
    ...preparedCatalog.matchedPresetLabels,
    ...((governedRetrieval?.citations ?? []).map((citation) => citation.label)),
  ])).slice(0, 16);
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer: composition.answer,
    classification: maxClassification,
    sourceTypes,
    sourceLabels,
    quoteId: selectedQuote?.id ?? null,
    customerId: selectedCustomer?.id ?? null,
    serviceType,
    model: composition.model,
    telemetry: combinedTelemetry,
    retrievalAuditEventId: governedRetrieval?.auditEventId ?? null,
    eventType: selectedQuote ? "REVISE" : "DRAFT",
    purpose: selectedQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
    confidenceLevel: composition.confidenceLevel,
    confidenceLabel: composition.confidenceLabel,
    insightReasons: composition.insightReasons,
    riskNote: governedRetrieval
      ? `${composition.riskNote} Retrieved excerpts were tenant-scoped, policy-filtered, and treated as untrusted source material.`
      : composition.riskNote,
  });
  const provenanceLinkedActions = actions.map((action) =>
    action.type === "OPEN_QUOTE_DRAFT"
      ? {
          ...action,
          payload: {
            ...action.payload,
            auditEventId: event.id,
          },
        }
      : action,
  );

  return {
    consumedCredits: 1,
    consumedSpendUsd: combinedTelemetry?.estimatedCostUsd ?? 0,
    assistant: {
      tool: "DRAFT_QUOTE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification,
      answer: composition.answer,
      results,
      citations,
      actions: provenanceLinkedActions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: composedDiagnostics(baseDiagnostics, composition),
    },
  };
}

export async function runAiAssistant(
  prisma: PrismaClient,
  params: AiAssistantInput,
): Promise<AiAssistantRunResult> {
  const generatedAtUtc = params.now ?? new Date();
  const tool = resolveAssistantTool(params.message, params.tool, params.context, params.conversation);
  let result: AiAssistantRunResult;

  if (tool === "ASSISTANT_HELP" || tool === "OUT_OF_SCOPE") {
    result = await runNonDataAssistantResponse(prisma, params, generatedAtUtc, tool);
  } else if (tool === "NAVIGATE_WORKSPACE") {
    result = await runWorkspaceNavigation(prisma, params, generatedAtUtc);
  } else if (tool === "DRAFT_CUSTOMER") {
    result = await runCustomerDraftPreview(prisma, params, generatedAtUtc);
  } else if (tool === "DRAFT_PRODUCT") {
    result = await runProductDraftPreview(prisma, params, generatedAtUtc);
  } else if (tool === "PREPARE_QUOTE_SEND") {
    result = await runPrepareQuoteSend(prisma, params, generatedAtUtc);
  } else if (tool === "LIST_MY_ACTIVITIES" || tool === "PRIORITIZE_MY_DAY") {
    result = await runActivityAgenda(prisma, params, generatedAtUtc, tool);
  } else if (tool === "PREPARE_ACTIVITY") {
    result = await runActivityDraftPreview(prisma, params, generatedAtUtc);
  } else if (tool === "LIST_SCHEDULE") {
    result = await runScheduleList(prisma, params, generatedAtUtc);
  } else if (tool === "PREPARE_BOOKING") {
    result = await runBookingPreview(prisma, params, generatedAtUtc);
  } else if (tool === "PREPARE_DISPATCH") {
    result = await runDispatchPreview(prisma, params, generatedAtUtc);
  } else if (tool === "FOLLOW_UP_QUEUE") {
    result = await runFollowUpQueue(prisma, params, generatedAtUtc);
  } else if (tool === "CUSTOMERS_WITHOUT_QUOTES") {
    result = await runCustomersWithoutQuotes(prisma, params, generatedAtUtc);
  } else if (tool === "PIPELINE_SCENARIO") {
    result = await runPipelineScenario(prisma, params, generatedAtUtc);
  } else if (tool === "SEARCH_CUSTOMERS") {
    result = await runCustomerSearch(prisma, params, generatedAtUtc);
  } else if (tool === "SEARCH_PRODUCTS") {
    result = await runProductSearch(prisma, params, generatedAtUtc);
  } else if (tool === "SEARCH_JOBS" || tool === "GET_JOB_STATUS") {
    result = await runJobLookup(prisma, params, generatedAtUtc, tool);
  } else if (tool === "LIST_INVOICES" || tool === "GET_INVOICE_STATUS") {
    result = await runInvoiceLookup(prisma, params, generatedAtUtc, tool);
  } else if (tool === "SUMMARIZE_PIPELINE") {
    result = await runBusinessInsightTool(prisma, params, generatedAtUtc, "SUMMARIZE_PIPELINE");
  } else if (tool === "RANK_PROFITABLE_JOBS") {
    result = await runBusinessInsightTool(prisma, params, generatedAtUtc, "RANK_PROFITABLE_JOBS");
  } else {
    result = await runDraftQuotePreview(prisma, params, generatedAtUtc);
  }

  return {
    ...result,
    assistant: {
      ...result.assistant,
      conversation: resolveAssistantConversationState(params.conversation, tool, assistantLocale(params)),
    },
  };
}
