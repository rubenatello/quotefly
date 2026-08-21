import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { productCatalogSource } from "../lib/product-catalog-display";
import { useLocale } from "../i18n";
import { localizedApiError } from "../lib/localized-api-error";

const TRADE_VALUES: ServiceType[] = ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"];
const CATEGORY_VALUES: WorkPresetCategory[] = ["SERVICE", "LABOR", "MATERIAL", "FEE"];
const UNIT_VALUES: WorkPresetUnitType[] = ["FLAT", "SQ_FT", "HOUR", "EACH"];

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
  const serviceType = typeof state.serviceType === "string" && TRADE_VALUES.includes(state.serviceType as ServiceType)
    ? state.serviceType as ServiceType
    : undefined;
  const category = typeof state.category === "string" && CATEGORY_VALUES.includes(state.category as WorkPresetCategory)
    ? state.category as WorkPresetCategory
    : undefined;
  const unitType = typeof state.unitType === "string" && UNIT_VALUES.includes(state.unitType as WorkPresetUnitType)
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

function money(value: number | string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(Number(value) || 0);
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
  const { t } = useTranslation();
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
  const marginLabel = margin === null ? t("products.editor.marginUnset") : t("products.editor.margin", { percent: margin.toFixed(1) });
  const tradeOptions = supportedTrades.map((trade) => ({ value: trade, label: t(`domain.trade.${trade}`) }));
  const categoryOptions = CATEGORY_VALUES.map((value) => ({ value, label: t(`domain.category.${value}`) }));
  const unitOptions = UNIT_VALUES.map((value) => ({ value, label: t(`domain.unit.${value}`) }));

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
      setError(t("products.editor.validationName"));
      return;
    }

    const quantity = Number(form.defaultQuantity);
    const cost = Number(form.unitCost);
    const price = Number(form.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError(t("products.editor.validationQuantity"));
      return;
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(price) || price < 0) {
      setError(t("products.editor.validationMoney"));
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
      closeOnBackdrop={false}
      ariaLabel={product ? t("products.editor.editTitle") : t("products.editor.addTitle")}
    >
      <ModalHeader
        title={product ? t("products.editor.editTitle") : t("products.editor.addTitle")}
        description={product ? t("products.editor.editDescription") : t("products.editor.addDescription")}
        onClose={requestClose}
      />
      <ModalBody className="space-y-5">
        {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
        {saveError ? <Alert tone="error" onDismiss={onDismissSaveError}>{saveError}</Alert> : null}
        {isStandard ? (
          <Alert tone="info">{t("products.editor.starterLocked")}</Alert>
        ) : null}
        {draft ? (
          <Alert tone="info">{t("products.editor.kodyDraft")}</Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={t("products.editor.name")}
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            placeholder={t("products.editor.namePlaceholder")}
            maxLength={120}
            disabled={saving || isStandard}
          />
          <Select
            label={t("products.trade")}
            value={form.serviceType}
            onChange={(event) => updateField("serviceType", event.target.value as ServiceType)}
            options={tradeOptions}
            disabled={saving || isStandard}
          />
        </div>

        <Textarea
          label={t("products.editor.description")}
          value={form.description}
          onChange={(event) => updateField("description", event.target.value)}
          placeholder={t("products.editor.descriptionPlaceholder")}
          rows={4}
          maxLength={500}
          disabled={saving}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t("products.editor.category")}
            value={form.category}
            onChange={(event) => updateField("category", event.target.value as WorkPresetCategory)}
            options={categoryOptions}
            disabled={saving || isStandard}
          />
          <Select
            label={t("products.editor.unit")}
            value={form.unitType}
            onChange={(event) => updateField("unitType", event.target.value as WorkPresetUnitType)}
            options={unitOptions}
            disabled={saving || isStandard}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label={t("products.editor.quantity")}
            type="number"
            min="0.01"
            step="0.01"
            value={form.defaultQuantity}
            onChange={(event) => updateField("defaultQuantity", event.target.value)}
            disabled={saving}
          />
          <Input
            label={t("products.editor.cost")}
            type="number"
            min="0"
            step="0.01"
            value={form.unitCost}
            onChange={(event) => updateField("unitCost", event.target.value)}
            disabled={saving}
          />
          <Input
            label={t("products.editor.price")}
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
            <span className="text-xs">{t("products.editor.costPrivacy")}</span>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={requestClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button onClick={submit} loading={saving}>{product ? t("common.save") : t("products.add")}</Button>
      </ModalFooter>
    </Modal>
    <ConfirmModal
      open={discardConfirmOpen}
      onClose={() => setDiscardConfirmOpen(false)}
      onConfirm={() => {
        setDiscardConfirmOpen(false);
        onClose();
      }}
      title={t("products.editor.discardTitle")}
      description={t("products.editor.discardDescription")}
      confirmLabel={t("products.editor.discard")}
      confirmVariant="warning"
    />
    </>
  );
}

function ProductMobileCard({ product, canViewInternalCosts, canManageCatalog, onEdit, onArchive }: {
  product: WorkPreset;
  canViewInternalCosts: boolean;
  canManageCatalog: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const margin = canViewInternalCosts ? marginPercent(product.unitCost ?? 0, product.unitPrice) : null;
  const source = productCatalogSource(product);
  return (
    <Card padding="md" className="space-y-4 md:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-slate-900">{product.name}</h2>
            <Badge tone={source.tone}>{product.catalogKey ? (product.catalogCustomizedAtUtc ? t("products.sourceCustomized") : t("products.sourceStandard")) : t("products.sourceTenant")}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600">
            {product.description || t("products.noDescription")}
          </p>
        </div>
        {canManageCatalog ? (
          <Button variant="outline" size="sm" icon={<Pencil size={14} />} onClick={onEdit} aria-label={t("products.editName", { name: product.name })}>
            {t("products.edit")}
          </Button>
        ) : null}
      </div>
      <div className={`grid gap-3 rounded-xl bg-slate-50 p-3 text-sm ${canViewInternalCosts ? "grid-cols-2" : "grid-cols-1"}`}>
        <div>
          <p className="text-xs text-slate-500">{t("products.columns.price")}</p>
          <p className="mt-1 font-semibold text-slate-900">{money(product.unitPrice, locale)}</p>
        </div>
        {canViewInternalCosts ? (
          <div>
            <p className="text-xs text-slate-500">{t("products.columns.cost")}</p>
            <p className="mt-1 font-semibold text-slate-900">{money(product.unitCost ?? 0, locale)}</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs text-slate-500">{t("products.columns.unit")}</p>
          <p className="mt-1 font-medium text-slate-700">{t(`domain.unit.${product.unitType}`)}</p>
        </div>
        {canViewInternalCosts ? (
          <div>
            <p className="text-xs text-slate-500">{t("products.columns.margin")}</p>
            <div className="mt-1"><Badge tone={marginTone(margin)}>{margin === null ? "—" : `${margin.toFixed(1)}%`}</Badge></div>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <Badge tone="slate">{t(`domain.category.${product.category}`)}</Badge>
        {product.catalogKey ? (
          <span className="text-xs font-medium text-slate-500">{t("products.sourceDetail")}</span>
        ) : canManageCatalog ? (
          <Button variant="ghost" size="sm" icon={<Archive size={14} />} onClick={onArchive}>{t("products.archive")}</Button>
        ) : null}
      </div>
    </Card>
  );
}

export function ProductsPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
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
  const [catalogPolicy, setCatalogPolicy] = useState<{
    canManageCatalog: boolean;
    canViewInternalCosts: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [syncingStarters, setSyncingStarters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<WorkPreset | null>(null);
  const [kodyProductDraft, setKodyProductDraft] = useState<KodyProductDraft | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkPreset | null>(null);
  const productRequestIdRef = useRef(0);
  const canManageCatalog = catalogPolicy?.canManageCatalog ?? false;
  const canViewInternalCosts = catalogPolicy?.canViewInternalCosts ?? false;
  const catalogPolicyLoaded = catalogPolicy !== null;

  useEffect(() => {
    setSEOMetadata({
      title: t("products.title"),
      description: t("products.subtitle"),
    });
  }, [t]);

  useEffect(() => {
    if (loading) return;
    if (!catalogPolicyLoaded || !canManageCatalog) return;
    const draft = kodyProductDraftFromState(location.state);
    if (!draft) return;
    setEditorError(null);
    setEditingProduct(null);
    setKodyProductDraft(draft);
    if (draft.serviceType) setSelectedTrade(draft.serviceType);
    setEditorOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [canManageCatalog, catalogPolicyLoaded, loading, location.pathname, location.search, location.state, navigate]);

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
      setCatalogPolicy(result.policy);
      setSupportedTrades(result.supportedTrades);
      if (!supportedTrades.length && selectedTrade === "ROOFING" && primaryTrade !== "ROOFING") {
        setSelectedTrade(primaryTrade);
        setProductPage(1);
      }
      setLoadError(null);
    } catch (err) {
      if (requestId !== productRequestIdRef.current) return;
      setLoadError(localizedApiError(err, t, { fallbackKey: "products.loadError" }));
    } finally {
      if (requestId === productRequestIdRef.current) setLoading(false);
    }
  }, [categoryFilter, debouncedSearchQuery, productPage, productPageSize, reloadKey, selectedTrade, supportedTrades.length, t]);

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

  const tradeOptions = (supportedTrades.length ? supportedTrades : TRADE_VALUES)
    .map((trade) => ({ value: trade, label: t(`domain.trade.${trade}`) }));
  const categoryOptions = CATEGORY_VALUES.map((category) => ({ value: category, label: t(`domain.category.${category}`) }));
  const totalProductPages = Math.max(1, Math.ceil(productTotal / productPageSize));

  useEffect(() => {
    if (productPage > totalProductPages) setProductPage(totalProductPages);
  }, [productPage, totalProductPages]);

  function openCreateProduct() {
    if (!canManageCatalog) return;
    setEditorError(null);
    setEditingProduct(null);
    setKodyProductDraft(null);
    setEditorOpen(true);
  }

  function openEditProduct(product: WorkPreset) {
    if (!canManageCatalog) return;
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
      setNotice(editingProduct ? t("products.updatedName", { name: result.product.name }) : t("products.addedName", { name: result.product.name }));
      setEditorOpen(false);
      setEditingProduct(null);
      setKodyProductDraft(null);
    } catch (err) {
      setEditorError(localizedApiError(err, t, { fallbackKey: "products.saveError" }));
    } finally {
      setSaving(false);
    }
  }

  async function archiveProduct() {
    if (!archiveTarget) return;
    if (archiveTarget.catalogKey) {
      setArchiveTarget(null);
      notify.warning(t("products.standardAvailable"), {
        description: t("products.standardAvailableDescription"),
      });
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      await api.products.archive(archiveTarget.id);
      setReloadKey((value) => value + 1);
      notify.success(t("products.archivedNotice"), {
        description: t("products.archivedName", { name: archiveTarget.name }),
      });
      setArchiveTarget(null);
    } catch (err) {
      notify.error(t("products.archiveError"), {
        description: localizedApiError(err, t, { fallbackKey: "products.unchanged" }),
      });
    } finally {
      setArchiving(false);
    }
  }

  async function addMissingStarterItems() {
    if (!canManageCatalog) return;
    setSyncingStarters(true);
    setError(null);
    try {
      const result = await api.products.syncStarterCatalog({ serviceType: selectedTrade });
      if (result.createdCount > 0) {
        const message = t("products.startersAdded", { count: result.createdCount, trade: t(`domain.trade.${selectedTrade}`) });
        setNotice(message);
        notify.success(t("products.startersAddedTitle"), { description: message });
        setProductPage(1);
        setReloadKey((value) => value + 1);
      } else {
        const message = t("products.startersCurrent", { trade: t(`domain.trade.${selectedTrade}`) });
        setNotice(message);
        notify.info(t("products.startersCurrentTitle"), { description: message });
      }
    } catch (err) {
      const message = localizedApiError(err, t, { fallbackKey: "products.startersError" });
      setError(message);
      notify.error(t("products.startersUnchanged"), { description: message });
    } finally {
      setSyncingStarters(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("products.title")}
        subtitle={t("products.subtitle")}
        mode="actions-only"
        actions={
          <>
            <KodyButton
              label={t("products.findProfitable")}
              prompt={t("products.findProfitablePrompt", { trade: t(`domain.trade.${selectedTrade}`) })}
              tool="RANK_PROFITABLE_JOBS"
              context={{
                currentPage: "products",
                serviceType: selectedTrade,
                limit: 8,
              }}
            />
            {catalogPolicyLoaded && canManageCatalog ? (
              <Button
                variant="outline"
                icon={<Boxes size={16} />}
                onClick={() => void addMissingStarterItems()}
                loading={syncingStarters}
                disabled={Boolean(loadError)}
              >
                {t("products.starterItems")}
              </Button>
            ) : null}
            {catalogPolicyLoaded && canManageCatalog ? (
              <Button icon={<PackagePlus size={16} />} onClick={openCreateProduct} disabled={Boolean(loadError)}>{t("products.add")}</Button>
            ) : null}
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      {catalogPolicyLoaded ? (
        <Alert tone="info">
        {canManageCatalog
          ? t("products.manageHelp")
          : t("products.readOnlyHelp")}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-quotefly-blue"><Boxes size={18} /></span>
            <div><p className="text-xs text-slate-500">{t("products.activeCatalog")}</p><p className="text-xl font-semibold text-slate-900">{productTotal}</p></div>
          </div>
        </Card>
        {catalogPolicyLoaded && canViewInternalCosts ? (
          <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><TrendingUp size={18} /></span>
            <div><p className="text-xs text-slate-500">{t("products.averageMargin")}</p><p className="text-xl font-semibold text-slate-900">{averageMargin === null ? "—" : `${averageMargin.toFixed(1)}%`}</p></div>
          </div>
          </Card>
        ) : null}
        <Card padding="sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><ShieldCheck size={18} /></span>
            <div><p className="text-xs text-slate-500">{t("products.standard")}</p><p className="text-xl font-semibold text-slate-900">{standardProductCount}</p></div>
          </div>
        </Card>
        <Card padding="sm">
          <p className="text-xs text-slate-500">{t("products.trade")}</p>
          <Select className="mt-1" aria-label={t("products.trade")} value={selectedTrade} onChange={(event) => { setSelectedTrade(event.target.value as ServiceType); setProductPage(1); }} options={tradeOptions} />
        </Card>
      </div>

      <Card padding="md">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-end">
          <Input
            label={t("products.searchLabel")}
            icon={<Search size={16} />}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("products.searchPlaceholder")}
          />
          <Select
            label={t("products.editor.category")}
            value={categoryFilter}
            onChange={(event) => { setCategoryFilter(event.target.value as "ALL" | WorkPresetCategory); setProductPage(1); }}
            options={[{ value: "ALL", label: t("products.allCategories") }, ...categoryOptions]}
          />
          <p className="pb-2 text-sm text-slate-500 md:text-right">{t("products.matched", { count: productTotal })}</p>
        </div>
      </Card>

      {loading ? (
        <LoadingState
          title={t("products.loading")}
          description={t("products.loadingDescription")}
          variant="table"
          rows={3}
        />
      ) : loadError ? (
        <Card>
          <EmptyState
            icon={<Boxes size={24} />}
            title={t("products.loadError")}
            description={`${loadError} ${t("products.unchanged")}`}
            action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>{t("products.retry")}</Button>}
          />
        </Card>
      ) : visibleProducts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Boxes size={24} />}
            title={debouncedSearchQuery || categoryFilter !== "ALL" ? t("products.noMatches") : t("products.emptyTrade", { trade: t(`domain.trade.${selectedTrade}`) })}
            description={debouncedSearchQuery || categoryFilter !== "ALL" ? t("products.noMatchesDescription") : t("products.emptyDescription")}
            action={debouncedSearchQuery || categoryFilter !== "ALL"
              ? <Button variant="outline" onClick={() => { setSearchQuery(""); setCategoryFilter("ALL"); setProductPage(1); }}>{t("products.clearFilters")}</Button>
              : catalogPolicyLoaded && canManageCatalog ? <Button icon={<PackagePlus size={16} />} onClick={openCreateProduct}>{t("products.add")}</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {visibleProducts.map((product) => (
              <ProductMobileCard
                key={product.id}
                product={product}
                canViewInternalCosts={canViewInternalCosts}
                canManageCatalog={canManageCatalog}
                onEdit={() => openEditProduct(product)}
                onArchive={() => setArchiveTarget(product)}
              />
            ))}
          </div>

          <Card padding="sm" className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className={`w-full text-left text-sm ${canViewInternalCosts || canManageCatalog ? "min-w-[900px]" : "min-w-[640px]"}`}>
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-3 font-semibold">{t("products.columns.item")}</th>
                    <th className="px-3 py-3 font-semibold">{t("products.columns.category")}</th>
                    <th className="px-3 py-3 font-semibold">{t("products.editor.quantity")}</th>
                    {canViewInternalCosts ? <th className="px-3 py-3 font-semibold">{t("products.columns.cost")}</th> : null}
                    <th className="px-3 py-3 font-semibold">{t("products.columns.price")}</th>
                    {canViewInternalCosts ? <th className="px-3 py-3 font-semibold">{t("products.columns.margin")}</th> : null}
                    {canManageCatalog ? <th className="px-3 py-3 text-right font-semibold">{t("products.columns.actions")}</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleProducts.map((product) => {
                    const margin = canViewInternalCosts ? marginPercent(product.unitCost ?? 0, product.unitPrice) : null;
                    const source = productCatalogSource(product);
                    return (
                      <tr key={product.id} className="align-top hover:bg-slate-50/70">
                        <td className="max-w-[340px] px-3 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-slate-900">{product.name}</p>
                            <Badge tone={source.tone}>{product.catalogKey ? (product.catalogCustomizedAtUtc ? t("products.sourceCustomized") : t("products.sourceStandard")) : t("products.sourceTenant")}</Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{product.description || t("products.noDescription")}</p>
                        </td>
                        <td className="px-3 py-4"><Badge tone="slate">{t(`domain.category.${product.category}`)}</Badge><p className="mt-2 text-xs text-slate-500">{t(`domain.unit.${product.unitType}`)}</p></td>
                        <td className="px-3 py-4 font-medium text-slate-700">{Number(product.defaultQuantity)}</td>
                        {canViewInternalCosts ? <td className="px-3 py-4 font-medium text-slate-700">{money(product.unitCost ?? 0, locale)}</td> : null}
                        <td className="px-3 py-4 font-semibold text-slate-900">{money(product.unitPrice, locale)}</td>
                        {canViewInternalCosts ? <td className="px-3 py-4"><Badge tone={marginTone(margin)}>{margin === null ? "—" : `${margin.toFixed(1)}%`}</Badge></td> : null}
                        {canManageCatalog ? <td className="px-3 py-4">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" icon={<Pencil size={14} />} onClick={() => openEditProduct(product)}>{t("products.edit")}</Button>
                            {product.catalogKey ? (
                              <span className="self-center text-xs font-medium text-slate-500">{t("products.sourceDetail")}</span>
                            ) : (
                              <Button variant="ghost" size="sm" icon={<Archive size={14} />} onClick={() => setArchiveTarget(product)} aria-label={t("products.archiveName", { name: product.name })}>{t("products.archive")}</Button>
                            )}
                          </div>
                        </td> : null}
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
        itemLabel={t("navigation.products").toLocaleLowerCase(locale)}
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
          supportedTrades={supportedTrades.length ? supportedTrades : TRADE_VALUES}
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
        title={t("products.archiveTitle")}
        description={archiveTarget ? t("products.archiveDescriptionName", { name: archiveTarget.name }) : undefined}
        confirmLabel={t("products.archiveConfirm")}
        loading={archiving}
        confirmVariant="warning"
      />
    </div>
  );
}
