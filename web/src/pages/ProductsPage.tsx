import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  Boxes,
  PackagePlus,
  Pencil,
  Search,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageHeader,
  PaginationControls,
  Select,
  Textarea,
  type PageSize,
} from "../components/ui";
import {
  ApiError,
  api,
  type ProductInput,
  type ServiceType,
  type WorkPreset,
  type WorkPresetCategory,
  type WorkPresetUnitType,
} from "../lib/api";
import { KodyButton } from "../components/ai/KodyButton";
import { setSEOMetadata } from "../lib/seo";
import { notify } from "../lib/notifications";

const TRADE_LABELS: Record<ServiceType, string> = {
  HVAC: "HVAC",
  PLUMBING: "Plumbing",
  FLOORING: "Flooring",
  ROOFING: "Roofing",
  GARDENING: "Gardening",
  CONSTRUCTION: "Construction",
};

const CATEGORY_LABELS: Record<WorkPresetCategory, string> = {
  SERVICE: "Service",
  LABOR: "Labor",
  MATERIAL: "Material",
  FEE: "Fee",
};

const UNIT_LABELS: Record<WorkPresetUnitType, string> = {
  FLAT: "Flat rate",
  SQ_FT: "Square foot",
  HOUR: "Hour",
  EACH: "Each",
};

const CATEGORY_OPTIONS = (Object.entries(CATEGORY_LABELS) as Array<[WorkPresetCategory, string]>).map(
  ([value, label]) => ({ value, label }),
);

const UNIT_OPTIONS = (Object.entries(UNIT_LABELS) as Array<[WorkPresetUnitType, string]>).map(
  ([value, label]) => ({ value, label }),
);

type ProductForm = {
  serviceType: ServiceType;
  name: string;
  description: string;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  defaultQuantity: string;
  unitCost: string;
  unitPrice: string;
};

type KodyProductDraft = Partial<ProductForm>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kodyProductDraftFromState(value: unknown): KodyProductDraft | null {
  if (!isRecord(value)) return null;
  const state = value.kodyProductDraft;
  if (!isRecord(state)) return null;
  const serviceType = typeof state.serviceType === "string" && state.serviceType in TRADE_LABELS
    ? state.serviceType as ServiceType
    : undefined;
  const category = typeof state.category === "string" && state.category in CATEGORY_LABELS
    ? state.category as WorkPresetCategory
    : undefined;
  const unitType = typeof state.unitType === "string" && state.unitType in UNIT_LABELS
    ? state.unitType as WorkPresetUnitType
    : undefined;
  const boundedNumber = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1_000_000
      ? String(candidate)
      : undefined;
  return {
    ...(serviceType ? { serviceType } : {}),
    ...(typeof state.name === "string" ? { name: state.name.trim().slice(0, 120) } : {}),
    ...(typeof state.description === "string" ? { description: state.description.trim().slice(0, 500) } : {}),
    ...(category ? { category } : {}),
    ...(unitType ? { unitType } : {}),
    ...(boundedNumber(state.defaultQuantity) ? { defaultQuantity: boundedNumber(state.defaultQuantity) } : {}),
    ...(boundedNumber(state.unitCost) ? { unitCost: boundedNumber(state.unitCost) } : {}),
    ...(boundedNumber(state.unitPrice) ? { unitPrice: boundedNumber(state.unitPrice) } : {}),
  };
}

function emptyProductForm(serviceType: ServiceType): ProductForm {
  return {
    serviceType,
    name: "",
    description: "",
    category: "SERVICE",
    unitType: "FLAT",
    defaultQuantity: "1",
    unitCost: "0",
    unitPrice: "0",
  };
}

function productToForm(product: WorkPreset): ProductForm {
  return {
    serviceType: product.serviceType,
    name: product.name,
    description: product.description ?? "",
    category: product.category,
    unitType: product.unitType,
    defaultQuantity: String(Number(product.defaultQuantity)),
    unitCost: String(Number(product.unitCost)),
    unitPrice: String(Number(product.unitPrice)),
  };
}

function money(value: number | string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value) || 0);
}

function marginPercent(unitCost: number | string, unitPrice: number | string): number | null {
  const cost = Number(unitCost);
  const price = Number(unitPrice);
  if (!Number.isFinite(cost) || !Number.isFinite(price) || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

function marginTone(margin: number | null): "emerald" | "amber" | "red" | "slate" {
  if (margin === null) return "slate";
  if (margin < 0) return "red";
  if (margin < 20) return "amber";
  return "emerald";
}

function ProductEditorModal({
  open,
  product,
  draft,
  defaultTrade,
  supportedTrades,
  saving,
  saveError,
  onClose,
  onDismissSaveError,
  onSave,
}: {
  open: boolean;
  product: WorkPreset | null;
  draft: KodyProductDraft | null;
  defaultTrade: ServiceType;
  supportedTrades: ServiceType[];
  saving: boolean;
  saveError: string | null;
  onClose: () => void;
  onDismissSaveError: () => void;
  onSave: (form: ProductForm) => Promise<void> | void;
}) {
  const initialForm = useMemo(
    () => product ? productToForm(product) : { ...emptyProductForm(defaultTrade), ...(draft ?? {}) },
    [defaultTrade, draft, product],
  );
  const [form, setForm] = useState<ProductForm>(initialForm);
  const [error, setError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const isStandard = Boolean(product?.catalogKey);
  const isDirty = (Object.keys(form) as Array<keyof ProductForm>).some(
    (field) => form[field] !== initialForm[field],
  );

  const margin = marginPercent(form.unitCost, form.unitPrice);
  const marginLabel = margin === null ? "Set a price to calculate margin" : `${margin.toFixed(1)}% gross margin`;

  function updateField<Key extends keyof ProductForm>(field: Key, value: ProductForm[Key]) {
    setError(null);
    onDismissSaveError();
    setForm((current) => ({ ...current, [field]: value }));
  }

  function requestClose() {
    if (saving) return;
    if (isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (!isDirty || saving) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty, saving]);

  function submit() {
    if (form.name.trim().length < 2) {
      setError("Enter a product or service name with at least 2 characters.");
      return;
    }

    const quantity = Number(form.defaultQuantity);
    const cost = Number(form.unitCost);
    const price = Number(form.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Default quantity must be greater than zero.");
      return;
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(price) || price < 0) {
      setError("Unit cost and customer price must be zero or greater.");
      return;
    }

    setError(null);
    void onSave(form);
  }

  return (
    <>
    <Modal
      open={open}
      onClose={requestClose}
      size="lg"
      modal={false}
      closeOnBackdrop={false}
      panelClassName="z-[60]"
      ariaLabel={product ? "Edit product" : "Add product"}
    >
      <ModalHeader
        title={product ? "Edit product" : "Add product or service"}
        description={
          isStandard
            ? "Standard catalog structure stays consistent; customize the description and pricing for your business."
            : "Save reusable labor, material, fee, or service pricing for faster quotes."
        }
        onClose={requestClose}
      />
      <ModalBody className="space-y-5">
        {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
        {saveError ? <Alert tone="error" onDismiss={onDismissSaveError}>{saveError}</Alert> : null}
        {isStandard ? (
          <Alert tone="info">Standard catalog names, trades, categories, and units are locked to keep quote matching reliable.</Alert>
        ) : null}
        {draft ? (
          <Alert tone="info">Kody prepared this draft from your request. Review every field—especially the pricing unit, internal cost, and customer price—before adding it.</Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Product or service name"
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            placeholder="Roof inspection"
            maxLength={120}
            disabled={saving || isStandard}
          />
          <Select
            label="Trade"
            value={form.serviceType}
            onChange={(event) => updateField("serviceType", event.target.value as ServiceType)}
            options={supportedTrades.map((trade) => ({ value: trade, label: TRADE_LABELS[trade] }))}
            disabled={saving || isStandard}
          />
        </div>

        <Textarea
          label="Customer-facing description"
          value={form.description}
          onChange={(event) => updateField("description", event.target.value)}
          placeholder="Describe the included work, materials, and useful scope details."
          rows={4}
          maxLength={500}
          disabled={saving}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Category"
            value={form.category}
            onChange={(event) => updateField("category", event.target.value as WorkPresetCategory)}
            options={CATEGORY_OPTIONS}
            disabled={saving || isStandard}
          />
          <Select
            label="Pricing unit"
            value={form.unitType}
            onChange={(event) => updateField("unitType", event.target.value as WorkPresetUnitType)}
            options={UNIT_OPTIONS}
            disabled={saving || isStandard}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Default quantity"
            type="number"
            min="0.01"
            step="0.01"
            value={form.defaultQuantity}
            onChange={(event) => updateField("defaultQuantity", event.target.value)}
            disabled={saving}
          />
          <Input
            label="Internal unit cost"
            type="number"
            min="0"
            step="0.01"
            value={form.unitCost}
            onChange={(event) => updateField("unitCost", event.target.value)}
            disabled={saving}
          />
          <Input
            label="Customer unit price"
            type="number"
            min="0"
            step="0.01"
            value={form.unitPrice}
            onChange={(event) => updateField("unitPrice", event.target.value)}
            disabled={saving}
          />
        </div>

        <div className={`rounded-xl border px-4 py-3 ${
          margin !== null && margin < 0
            ? "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] text-[var(--qf-danger-text)]"
            : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]"
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{marginLabel}</span>
            <span className="text-xs">Internal cost never appears on customer PDFs.</span>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={requestClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>{product ? "Save changes" : "Add product"}</Button>
      </ModalFooter>
    </Modal>
    <ConfirmModal
      open={discardConfirmOpen}
      onClose={() => setDiscardConfirmOpen(false)}
      onConfirm={() => {
        setDiscardConfirmOpen(false);
        onClose();
      }}
      title="Discard unsaved product changes?"
      description="Pricing, description, and product details changed in this window will be lost."
      confirmLabel="Discard changes"
      confirmVariant="warning"
    />
    </>
  );
}

function ProductMobileCard({ product, onEdit, onArchive }: {
  product: WorkPreset;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const margin = marginPercent(product.unitCost ?? 0, product.unitPrice);
  return (
    <Card padding="md" className="space-y-4 md:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-slate-900">{product.name}</h2>
            <Badge tone={product.catalogKey ? "blue" : "slate"}>{product.catalogKey ? "Standard" : "Custom"}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600">
            {product.description || "No customer-facing description yet."}
          </p>
        </div>
        <Button variant="outline" size="sm" icon={<Pencil size={14} />} onClick={onEdit} aria-label={`Edit ${product.name}`}>
          Edit
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-sm">
        <div>
          <p className="text-xs text-slate-500">Customer price</p>
          <p className="mt-1 font-semibold text-slate-900">{money(product.unitPrice)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Internal cost</p>
          <p className="mt-1 font-semibold text-slate-900">{money(product.unitCost ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Unit</p>
          <p className="mt-1 font-medium text-slate-700">{UNIT_LABELS[product.unitType]}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Margin</p>
          <div className="mt-1"><Badge tone={marginTone(margin)}>{margin === null ? "—" : `${margin.toFixed(1)}%`}</Badge></div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Badge tone="slate">{CATEGORY_LABELS[product.category]}</Badge>
        {product.catalogKey ? (
          <span className="text-xs font-medium text-slate-500">Always available</span>
        ) : (
          <Button variant="ghost" size="sm" icon={<Archive size={14} />} onClick={onArchive}>Archive</Button>
        )}
      </div>
    </Card>
  );
}

export function ProductsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [products, setProducts] = useState<WorkPreset[]>([]);
  const [supportedTrades, setSupportedTrades] = useState<ServiceType[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<ServiceType>("ROOFING");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | WorkPresetCategory>("ALL");
  const [productPage, setProductPage] = useState(1);
  const [productPageSize, setProductPageSize] = useState<PageSize>(25);
  const [productTotal, setProductTotal] = useState(0);
  const [standardProductCount, setStandardProductCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<WorkPreset | null>(null);
  const [kodyProductDraft, setKodyProductDraft] = useState<KodyProductDraft | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkPreset | null>(null);
  const productRequestIdRef = useRef(0);

  useEffect(() => {
    setSEOMetadata({
      title: "Products & Services",
      description: "Manage reusable products, services, costs, and customer pricing for QuoteFly quotes.",
    });
  }, []);

  useEffect(() => {
    if (loading) return;
    const draft = kodyProductDraftFromState(location.state);
    if (!draft) return;
    setEditorError(null);
    setEditingProduct(null);
    setKodyProductDraft(draft);
    if (draft.serviceType) setSelectedTrade(draft.serviceType);
    setEditorOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [loading, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
      setProductPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  const loadProductPage = useCallback(async () => {
    void reloadKey;
    const requestId = ++productRequestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.products.list({
        serviceType: selectedTrade,
        category: categoryFilter === "ALL" ? undefined : categoryFilter,
        search: debouncedSearchQuery || undefined,
        limit: productPageSize,
        offset: (productPage - 1) * productPageSize,
      });
      if (requestId !== productRequestIdRef.current) return;
      const primaryTrade = result.primaryTrade ?? result.supportedTrades[0] ?? "ROOFING";
      setProducts(result.products);
      setProductTotal(result.pagination.total);
      setStandardProductCount(result.summary.standardCount);
      setSupportedTrades(result.supportedTrades);
      if (!supportedTrades.length && selectedTrade === "ROOFING" && primaryTrade !== "ROOFING") {
        setSelectedTrade(primaryTrade);
        setProductPage(1);
      }
      setLoadError(null);
    } catch (err) {
      if (requestId !== productRequestIdRef.current) return;
      setLoadError(err instanceof ApiError ? err.message : "Products could not be loaded.");
    } finally {
      if (requestId === productRequestIdRef.current) setLoading(false);
    }
  }, [categoryFilter, debouncedSearchQuery, productPage, productPageSize, reloadKey, selectedTrade, supportedTrades.length]);

  useEffect(() => {
    void loadProductPage();
  }, [loadProductPage]);

  const tradeProducts = products;
  const visibleProducts = products;

  const averageMargin = useMemo(() => {
    const values = tradeProducts
      .map((product) => marginPercent(product.unitCost ?? 0, product.unitPrice))
      .filter((value): value is number => value !== null);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [tradeProducts]);

  const tradeOptions = (supportedTrades.length ? supportedTrades : Object.keys(TRADE_LABELS) as ServiceType[])
    .map((trade) => ({ value: trade, label: TRADE_LABELS[trade] }));
  const totalProductPages = Math.max(1, Math.ceil(productTotal / productPageSize));

  useEffect(() => {
    if (productPage > totalProductPages) setProductPage(totalProductPages);
  }, [productPage, totalProductPages]);

  function openCreateProduct() {
    setEditorError(null);
    setEditingProduct(null);
    setKodyProductDraft(null);
    setEditorOpen(true);
  }

  function openEditProduct(product: WorkPreset) {
    setEditorError(null);
    setEditingProduct(product);
    setKodyProductDraft(null);
    setEditorOpen(true);
  }

  async function saveProduct(form: ProductForm) {
    setSaving(true);
    setEditorError(null);
    try {
      const payload: ProductInput = {
        serviceType: form.serviceType,
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category,
        unitType: form.unitType,
        defaultQuantity: Number(form.defaultQuantity),
        unitCost: Number(form.unitCost),
        unitPrice: Number(form.unitPrice),
        isDefault: true,
      };

      const result = editingProduct
        ? await api.products.update(
            editingProduct.id,
            editingProduct.catalogKey
              ? {
                  description: payload.description,
                  defaultQuantity: payload.defaultQuantity,
                  unitCost: payload.unitCost,
                  unitPrice: payload.unitPrice,
                }
              : payload,
          )
        : await api.products.create(payload);

      setSelectedTrade(result.product.serviceType);
      setProductPage(1);
      setReloadKey((value) => value + 1);
      setNotice(editingProduct ? `${result.product.name} updated.` : `${result.product.name} added to your catalog.`);
      setEditorOpen(false);
      setEditingProduct(null);
      setKodyProductDraft(null);
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : "Product could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveProduct() {
    if (!archiveTarget) return;
    if (archiveTarget.catalogKey) {
      setArchiveTarget(null);
      notify.warning("Standard product stays available", {
        description: "Edit its pricing or description instead of archiving it.",
      });
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      await api.products.archive(archiveTarget.id);
      setReloadKey((value) => value + 1);
      notify.success("Product archived", {
        description: `${archiveTarget.name} was removed from new quote lists. Existing quotes are unchanged.`,
      });
      setArchiveTarget(null);
    } catch (err) {
      notify.error("Product could not be archived", {
        description: err instanceof ApiError ? err.message : "Please try again. The product was not changed.",
      });
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products & services"
        subtitle="Keep reusable work, pricing, and scope details ready for fast, consistent quotes."
        mode="actions-only"
        actions={
          <>
            <KodyButton
              label="Find profitable services"
              prompt={`Rank profitable jobs and products for ${TRADE_LABELS[selectedTrade]}. Use safe tenant-scoped analytics to suggest which services are worth quoting more often.`}
              tool="RANK_PROFITABLE_JOBS"
              context={{
                currentPage: "products",
                serviceType: selectedTrade,
                limit: 8,
              }}
            />
            <Button icon={<PackagePlus size={16} />} onClick={openCreateProduct} disabled={Boolean(loadError)}>Add product</Button>
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-quotefly-blue"><Boxes size={18} /></span>
            <div><p className="text-xs text-slate-500">Active catalog</p><p className="text-xl font-semibold text-slate-900">{productTotal}</p></div>
          </div>
        </Card>
        <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><TrendingUp size={18} /></span>
            <div><p className="text-xs text-slate-500">Page average margin</p><p className="text-xl font-semibold text-slate-900">{averageMargin === null ? "—" : `${averageMargin.toFixed(1)}%`}</p></div>
          </div>
        </Card>
        <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><ShieldCheck size={18} /></span>
            <div><p className="text-xs text-slate-500">Standard items</p><p className="text-xl font-semibold text-slate-900">{standardProductCount}</p></div>
          </div>
        </Card>
        <Card padding="sm">
          <p className="text-xs text-slate-500">Catalog trade</p>
          <Select className="mt-1" aria-label="Catalog trade" value={selectedTrade} onChange={(event) => { setSelectedTrade(event.target.value as ServiceType); setProductPage(1); }} options={tradeOptions} />
        </Card>
      </div>

      <Card padding="md">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-end">
          <Input
            label="Search catalog"
            icon={<Search size={16} />}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by name, description, or type"
          />
          <Select
            label="Category"
            value={categoryFilter}
            onChange={(event) => { setCategoryFilter(event.target.value as "ALL" | WorkPresetCategory); setProductPage(1); }}
            options={[{ value: "ALL", label: "All categories" }, ...CATEGORY_OPTIONS]}
          />
          <p className="pb-2 text-sm text-slate-500 md:text-right">{productTotal} matched</p>
        </div>
      </Card>

      {loading ? (
        <LoadingState
          title="Loading products"
          description="Fetching reusable work, pricing, and margin defaults for this trade."
          variant="table"
          rows={3}
        />
      ) : loadError ? (
        <Card>
          <EmptyState
            icon={<Boxes size={24} />}
            title="Products are temporarily unavailable"
            description={`${loadError} Your catalog was not changed.`}
            action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Try again</Button>}
          />
        </Card>
      ) : visibleProducts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Boxes size={24} />}
            title={debouncedSearchQuery || categoryFilter !== "ALL" ? "No products match these filters" : `No ${TRADE_LABELS[selectedTrade]} products yet`}
            description={debouncedSearchQuery || categoryFilter !== "ALL" ? "Clear the search or choose another category." : "Add the work and pricing your team reuses most often."}
            action={debouncedSearchQuery || categoryFilter !== "ALL"
              ? <Button variant="outline" onClick={() => { setSearchQuery(""); setCategoryFilter("ALL"); setProductPage(1); }}>Clear filters</Button>
              : <Button icon={<PackagePlus size={16} />} onClick={openCreateProduct}>Add first product</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {visibleProducts.map((product) => (
              <ProductMobileCard key={product.id} product={product} onEdit={() => openEditProduct(product)} onArchive={() => setArchiveTarget(product)} />
            ))}
          </div>

          <Card padding="sm" className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-3 font-semibold">Product</th>
                    <th className="px-3 py-3 font-semibold">Type</th>
                    <th className="px-3 py-3 font-semibold">Default qty</th>
                    <th className="px-3 py-3 font-semibold">Internal cost</th>
                    <th className="px-3 py-3 font-semibold">Customer price</th>
                    <th className="px-3 py-3 font-semibold">Margin</th>
                    <th className="px-3 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleProducts.map((product) => {
                    const margin = marginPercent(product.unitCost ?? 0, product.unitPrice);
                    return (
                      <tr key={product.id} className="align-top hover:bg-slate-50/70">
                        <td className="max-w-[340px] px-3 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-slate-900">{product.name}</p>
                            <Badge tone={product.catalogKey ? "blue" : "slate"}>{product.catalogKey ? "Standard" : "Custom"}</Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{product.description || "No customer-facing description yet."}</p>
                        </td>
                        <td className="px-3 py-4"><Badge tone="slate">{CATEGORY_LABELS[product.category]}</Badge><p className="mt-2 text-xs text-slate-500">{UNIT_LABELS[product.unitType]}</p></td>
                        <td className="px-3 py-4 font-medium text-slate-700">{Number(product.defaultQuantity)}</td>
                        <td className="px-3 py-4 font-medium text-slate-700">{money(product.unitCost ?? 0)}</td>
                        <td className="px-3 py-4 font-semibold text-slate-900">{money(product.unitPrice)}</td>
                        <td className="px-3 py-4"><Badge tone={marginTone(margin)}>{margin === null ? "—" : `${margin.toFixed(1)}%`}</Badge></td>
                        <td className="px-3 py-4">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" icon={<Pencil size={14} />} onClick={() => openEditProduct(product)}>Edit</Button>
                            {product.catalogKey ? (
                              <span className="self-center text-xs font-medium text-slate-500">Always available</span>
                            ) : (
                              <Button variant="ghost" size="sm" icon={<Archive size={14} />} onClick={() => setArchiveTarget(product)} aria-label={`Archive ${product.name}`}>Archive</Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <PaginationControls
        limit={productPageSize}
        offset={(productPage - 1) * productPageSize}
        total={productTotal}
        loading={loading}
        itemLabel="products"
        onLimitChange={(nextLimit) => {
          setProductPageSize(nextLimit);
          setProductPage(1);
        }}
        onOffsetChange={(nextOffset) => setProductPage(Math.floor(nextOffset / productPageSize) + 1)}
      />

      {editorOpen ? (
        <ProductEditorModal
          key={editingProduct?.id ?? (kodyProductDraft ? "kody-product-draft" : "new-product")}
          open
          product={editingProduct}
          draft={kodyProductDraft}
          defaultTrade={selectedTrade}
          supportedTrades={supportedTrades.length ? supportedTrades : Object.keys(TRADE_LABELS) as ServiceType[]}
          saving={saving}
          saveError={editorError}
          onDismissSaveError={() => setEditorError(null)}
          onClose={() => { if (!saving) { setEditorOpen(false); setEditingProduct(null); setKodyProductDraft(null); setEditorError(null); } }}
          onSave={saveProduct}
        />
      ) : null}

      <ConfirmModal
        open={Boolean(archiveTarget)}
        onClose={() => { if (!archiving) setArchiveTarget(null); }}
        onConfirm={() => void archiveProduct()}
        title="Archive product?"
        description={archiveTarget ? `${archiveTarget.name} will stop appearing in new quote product lists. Existing quotes stay unchanged.` : undefined}
        confirmLabel="Archive product"
        loading={archiving}
        confirmVariant="warning"
      />
    </div>
  );
}
