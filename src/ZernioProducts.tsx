import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@ten98/ui';
import { AppField as Field } from '@ten98/ui/app';

type Account = { id: string; platform: 'shopify'; name: string; isActive: boolean; needsReconnection: boolean };
type Store = { accountId: string; platform: 'shopify'; name: string; domain: string; url: string | null; currency: string; country: string | null; capabilities: string[]; missingCapabilities: string[]; grantPermissionsUrl: string | null };
type Money = { amount: string; currency: string };
type Image = { id: string | null; url: string; altText: string | null };
type Variant = { id: string; title: string; sku: string | null; barcode: string | null; price: Money; compareAtPrice: Money | null; inventoryQuantity: number | null; availableForSale: boolean | null; options: { name: string; value: string }[] };
type StockLocation = { id: string; name: string | null; isActive: boolean | null; fulfillsOnlineOrders: boolean | null; address: null | { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; countryCode: string | null; phone: string | null } };
type StockLevel = { locationId: string; available: number | null; onHand: number | null; committed: number | null; incoming: number | null };
type StockItem = { productId: string; variantId: string; sku: string | null; tracked: boolean | null; levels: StockLevel[] | null };
type StockSnapshot = { product: Product; locations: StockLocation[]; inventory: StockItem[]; loadedAt: string };
export type Product = { id: string; accountId: string; platform: 'shopify'; title: string; descriptionHtml: string | null; handle: string | null; vendor: string | null; productType: string | null; tags: string[]; status: string; platformStatus: string; featuredImage: Image | null; images: Image[]; options: { name: string; values: string[] }[]; variants: Variant[]; totalInventory: number | null; url: string | null; seo: { title: string | null; description: string | null }; createdAt: string | null; updatedAt: string | null; publishedAt: string | null };
export type ProductAccount = Account;
export type ProductStore = Store;
type Request = (path: string, body?: unknown, validate?: (value: any) => void, outcomeOnly?: boolean) => Promise<any>;
const productRequestNotSent = (problem: { code?: string; operation?: { status?: string } }) => problem.code === 'OPERATION_NOT_SENT' || problem.operation?.status === 'failed';
const productNotSentMessage = 'Earlier request was not sent. Refresh the current product or store and review a new action.';
const statuses = ['active', 'draft', 'pending_review', 'rejected', 'inactive', 'archived', 'deleted'];
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(row => typeof row === 'string');
const sameTags = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const nullableCount = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value);
const money = (value: any): value is Money => !!value && typeof value.amount === 'string' && typeof value.currency === 'string';
const image = (value: any): value is Image => !!value && nullableText(value.id) && typeof value.url === 'string' && nullableText(value.altText);
const readableStore = (value: any, accountId: string): value is Store => !!value && value.accountId === accountId && value.platform === 'shopify' && ['name', 'domain', 'currency'].every(key => typeof value[key] === 'string') && ['url', 'country', 'grantPermissionsUrl'].every(key => nullableText(value[key])) && texts(value.capabilities) && texts(value.missingCapabilities);
const readableProduct = (value: any, accountId: string): value is Product => !!value && typeof value.id === 'string' && !!value.id && value.accountId === accountId && value.platform === 'shopify' && typeof value.title === 'string' && statuses.includes(value.status) && typeof value.platformStatus === 'string' && ['descriptionHtml', 'handle', 'vendor', 'productType', 'url', 'createdAt', 'updatedAt', 'publishedAt'].every(key => nullableText(value[key])) && texts(value.tags) && nullableCount(value.totalInventory) && !!value.seo && nullableText(value.seo.title) && nullableText(value.seo.description) && (value.featuredImage === null || image(value.featuredImage)) && Array.isArray(value.images) && value.images.length <= 20 && value.images.every(image) && Array.isArray(value.options) && value.options.every((row: any) => row && typeof row.name === 'string' && texts(row.values)) && Array.isArray(value.variants) && value.variants.length <= 100 && value.variants.every((row: any) => row && typeof row.id === 'string' && typeof row.title === 'string' && nullableText(row.sku) && nullableText(row.barcode) && money(row.price) && (row.compareAtPrice === null || money(row.compareAtPrice)) && nullableCount(row.inventoryQuantity) && (row.availableForSale === null || typeof row.availableForSale === 'boolean') && Array.isArray(row.options) && row.options.every((option: any) => option && typeof option.name === 'string' && typeof option.value === 'string'));
const storeIdentity = (value: Store) => JSON.stringify([value.accountId, value.platform, value.name, value.domain, value.url, value.currency, value.country, value.capabilities, value.missingCapabilities, value.grantPermissionsUrl]);
const editableProduct = (account: Account, store: Store, product: Product) => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && ['products.read', 'products.update'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope)) && readableProduct(product, account.id) && product.status !== 'deleted';
const priceableProduct = (account: Account, store: Store, product: Product) => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && /^[A-Z]{3}$/.test(store.currency) && ['products.read', 'products.price'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope)) && readableProduct(product, account.id) && product.status !== 'deleted';
const creatableProduct = (account: Account, store: Store) => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && /^[A-Z]{3}$/.test(store.currency) && ['products.read', 'products.create'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope));
const stockableProduct = (account: Account, store: Store, product: Product) => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && ['products.read', 'inventory.read'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope)) && readableProduct(product, account.id);
const productStateAllowed = (account: Account, store: Store, product: Product, action: 'deactivate' | 'archive' | 'activate' | 'delete' = 'deactivate') => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && ['products.read', 'products.status'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope)) && readableProduct(product, account.id) && nativeVariantId(product.id) && (action === 'delete' ? product.status === 'archived' && product.platformStatus === 'ARCHIVED' : action === 'archive' ? ['active', 'draft'].includes(product.status) && product.platformStatus === product.status.toUpperCase() : action === 'activate' ? product.status === 'draft' && product.platformStatus === 'DRAFT' : action === 'deactivate' && product.status === 'active' && product.platformStatus === 'ACTIVE');
const nullableFlag = (value: unknown) => value === null || typeof value === 'boolean';
function stockSnapshot(value: any, account: Account, store: Store, product: Product): StockSnapshot {
  if (value?.accountId !== account.id || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(store) || !readableProduct(value?.product, account.id) || value.product.id !== product.id || !stockableProduct(account, value.store, value.product) || value.coverage?.imagesLimit !== 20 || value.coverage?.variantsLimit !== 100 || value.coverage?.inventoryComplete !== null || value.coverage?.locationsComplete !== null || value.coverage?.localLocationsLimit !== 1000 || value.coverage?.localInventoryItemsLimit !== 10000 || value.coverage?.localInventoryLevelsLimit !== 10000 || !Array.isArray(value.locations) || value.locations.length > 1000 || value.locations.some((row: any) => !row || typeof row.id !== 'string' || !nativeVariantId(row.id) || !nullableText(row.name) || !nullableFlag(row.isActive) || !nullableFlag(row.fulfillsOnlineOrders) || row.address !== null && (!row.address || typeof row.address !== 'object' || Array.isArray(row.address) || !['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode', 'phone'].every(key => nullableText(row.address[key])))) || new Set(value.locations.map((row: StockLocation) => row.id)).size !== value.locations.length || !Array.isArray(value.inventory) || value.inventory.length > 10000 || value.inventory.some((row: any) => !row || row.productId !== product.id || typeof row.variantId !== 'string' || !nativeVariantId(row.variantId) || !nullableText(row.sku) || !nullableFlag(row.tracked) || row.levels !== null && (!Array.isArray(row.levels) || row.levels.some((level: any) => !level || typeof level.locationId !== 'string' || !nativeVariantId(level.locationId) || !['available', 'onHand', 'committed', 'incoming'].every(key => nullableCount(level[key]))) || new Set(row.levels.map((level: StockLevel) => level.locationId)).size !== row.levels.length)) || new Set(value.inventory.map((row: StockItem) => row.variantId)).size !== value.inventory.length || value.inventory.reduce((count: number, row: StockItem) => count + (row.levels?.length ?? 0), 0) > 10000) throw new Error('The stock, locations, exact product and reading permissions could not be verified. Load the current product and try again.');
  return { product: value.product, locations: value.locations, inventory: value.inventory, loadedAt: new Date().toISOString() };
}
function pageCursor(value: unknown, used: Set<string>) {
  if (value === null) return '';
  if (typeof value !== 'string' || !value || value.length > 8192 || used.has(value)) throw new Error('The next page could not be verified. Load the first page again.');
  return value;
}
function failureMessage(failure: unknown) {
  const problem = failure as { status?: number; code?: string; message?: string };
  if (problem?.status === 429 || /RATE_LIMIT/.test(problem?.code || '')) return 'The store provider is rate limited. Try loading again later.';
  if (problem?.code === 'PRODUCT_READ_PERMISSION_REQUIRED') return 'Product read permission is missing or unavailable. Check your store connection and permissions.';
  return problem?.message || 'The store request failed. Try loading again.';
}

type Collection = { id: string; accountId: string; platform: 'shopify'; title: string; handle: string | null; descriptionHtml: string | null; image: Image | null; sortOrder: string | null; productCount: number | null; seo: { title: string | null; description: string | null }; updatedAt: string | null };
export type ProductCollection = Collection;
const collectionSortOrders = ['manual', 'best_selling', 'alpha_asc', 'alpha_desc', 'price_asc', 'price_desc', 'created', 'created_desc', 'most_relevant'];
const nativeCollectionId = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 500 && !/[\u0000-\u001f\u007f-\u009f\s]/.test(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..');
const readableCollection = (value: any, accountId: string): value is Collection => !!value && nativeCollectionId(value.id) && value.accountId === accountId && value.platform === 'shopify' && typeof value.title === 'string' && ['handle', 'descriptionHtml', 'updatedAt'].every(key => nullableText(value[key])) && (value.image === null || image(value.image)) && (value.sortOrder === null || collectionSortOrders.includes(value.sortOrder)) && nullableCount(value.productCount) && (value.productCount === null || value.productCount >= 0) && !!value.seo && nullableText(value.seo.title) && nullableText(value.seo.description);
const collectionProductsReadable = (store: Store) => ['products.read', 'collections.read'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope));
const renameableCollection = (account: Account, store: Store, collection: Collection) => account.platform === 'shopify' && account.isActive && !account.needsReconnection && readableStore(store, account.id) && ['collections.read', 'collections.write'].every(scope => store.capabilities.includes(scope) && !store.missingCapabilities.includes(scope)) && readableCollection(collection, account.id);
type CollectionSelection = { collection: Collection; store: Store };
function CollectionsBrowser({ account, request, onBrowse, onRename, selectedCollectionId }: { account: Account; request: Request; onBrowse?: (account: Account, store: Store, collection: Collection) => void; onRename?: (account: Account, store: Store, collection: Collection) => void; selectedCollectionId?: string }) {
  const [query, setQuery] = useState(''), [store, setStore] = useState<Store | null>(null), [collections, setCollections] = useState<Collection[] | null>(null), [collection, setCollection] = useState<Collection | null>(null);
  const [nextCursor, setNextCursor] = useState(''), [page, setPage] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const requester = useRef(request), mounted = useRef(true), reads = useRef(0), cursors = useRef(new Set<string>());
  const view = useMemo(() => ({ pending: false }), [account, query]), committed = useRef(view);
  const actions = useMemo(() => ({}), [view, store, collections, collection, nextCursor, page, onBrowse, onRename, selectedCollectionId]), committedActions = useRef(actions);
  const current = () => mounted.current && committed.current === view;
  function clear() { setStore(null); setCollections(null); setCollection(null); setNextCursor(''); setPage(1); }
  useLayoutEffect(() => { requester.current = request; }, [request]);
  useLayoutEffect(() => { committedActions.current = actions; }, [actions]);
  useLayoutEffect(() => { committed.current = view; reads.current++; cursors.current = new Set(); clear(); setLoaded(false); setBusy(false); setError(''); }, [view]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  function browseProducts() {
    if (current() && committedActions.current === actions && !view.pending && account.isActive && !account.needsReconnection && store && collection && collectionProductsReadable(store) && readableCollection(collection, account.id)) onBrowse?.(account, store, collection);
  }
  function rename() {
    if (current() && committedActions.current === actions && !view.pending && store && collection && renameableCollection(account, store, collection)) onRename?.(account, store, collection);
  }
  async function load(cursor = '', collectionId = '') {
    if (!current() || committedActions.current !== actions || view.pending || account.platform !== 'shopify' || !account.isActive || account.needsReconnection) return;
    const previousStore = store, used = cursor ? new Set([...cursors.current, cursor]) : new Set<string>(), nextPage = cursor ? page + 1 : 1;
    view.pending = true; const read = ++reads.current; clear(); setBusy(true); setError('');
    try {
      if (query.length > 500) throw new Error('Use a collection query of at most 500 characters.');
      if (cursor && (cursor !== nextCursor || cursor.length > 8192)) throw new Error('The requested collection page could not be verified. Refresh the first page.');
      if (collectionId && !collections?.some(row => row.id === collectionId)) throw new Error('Choose a collection returned on the current page.');
      const params = new URLSearchParams({ limit: '20' }); if (cursor) params.set('cursor', cursor); if (query) params.set('query', query);
      const result = await requester.current(`products/${encodeURIComponent(account.id)}/collections` + (collectionId ? '/' + encodeURIComponent(collectionId) : '?' + params.toString()));
      if (!current() || read !== reads.current) return;
      if (result?.accountId !== account.id || !readableStore(result?.store, account.id) || (cursor || collectionId) && (!previousStore || storeIdentity(previousStore) !== storeIdentity(result.store))) throw new Error('The collection account and store could not be verified. Refresh the first page.');
      if (!result.store.capabilities.includes('collections.read') || result.store.missingCapabilities.includes('collections.read')) throw new Error('Collection read permission is missing or unavailable. Check your Shopify connection and permissions, then load again.');
      if (collectionId) {
        if (!readableCollection(result?.collection, account.id) || result.collection.id !== collectionId) throw new Error('The selected collection could not be verified. Refresh the first page.');
        setCollection(result.collection); cursors.current = new Set();
      } else {
        if (!Array.isArray(result?.collections) || result.collections.length > 20 || !result.collections.every((row: unknown) => readableCollection(row, account.id)) || new Set(result.collections.map((row: Collection) => row.id)).size !== result.collections.length) throw new Error('The collection page could not be verified. Refresh the first page.');
        const next = pageCursor(result.nextCursor, used); cursors.current = used; setCollections(result.collections); setNextCursor(next); setPage(nextPage);
      }
      setStore(result.store); setLoaded(true);
    } catch (failure) {
      if (current() && read === reads.current) {
        clear(); cursors.current = new Set(); const problem = failure as { status?: number; code?: string; message?: string };
        setError(problem.status === 403 ? problem.code === 'PROJECT_ACCESS_CHANGED' ? failureMessage(failure) : 'Collection read permission is missing or unavailable. Check your Shopify connection and permissions, then load again.' : problem.status === 404 ? 'The collection or store was not found. Refresh the first page and choose a returned collection.' : failureMessage(failure));
      }
    } finally { if (current() && read === reads.current) { view.pending = false; setBusy(false); } }
  }
  return <section aria-label="Collections" className="panel"><h3>Collections</h3><p className="helper-note">{onRename ? 'Collection metadata is read-only; eligible title changes require review.' : 'Read-only.'} Returned rows only; collection completeness and provider freshness are unknown. Product counts can lag membership. Visibility, publication, collection type, rules and member products are unknown.</p>
    <Field label="Platform collection query" name="collectionQuery" type="search" maxLength={500} value={query} onChange={event => { if (current()) setQuery(event.target.value); }}/>
    <div className="button-wrap"><button type="button" className="button" disabled={busy || !account.isActive || account.needsReconnection} onClick={() => load()}>{loaded ? 'Refresh first collection page' : 'Load collections'}</button>{collections !== null && <span>Collection page {page}</span>}{nextCursor && <button type="button" className="button" disabled={busy} onClick={() => load(nextCursor)}>Next collection page</button>}</div>
    {(!account.isActive || account.needsReconnection) && <p>Reconnect this Shopify account before reading collections.</p>}{busy && <p role="status">Loading collections…</p>}{error && <p className="alert" role="alert">{error}</p>}
    {store && <p>Account {store.accountId} · Store {store.domain} · Collection read permission verified</p>}
    {onRename && store && collection && renameableCollection(account, store, collection) && <button type="button" className="button" disabled={busy} onClick={rename}>Rename collection title</button>}
    {collections !== null && (collections.length ? <div className="table-scroll"><table><thead><tr><th>Collection</th><th>Native ID</th><th>Product count</th><th>Action</th></tr></thead><tbody>{collections.map(row => <tr key={row.id}><td>{row.title || row.id}</td><td>{row.id}</td><td>{row.productCount ?? 'Unknown'}</td><td><button type="button" className="button" disabled={busy} onClick={() => load('', row.id)}>Read collection {row.title || row.id}</button></td></tr>)}</tbody></table></div> : <p>No collections were returned for this page and query. Collection completeness is unknown.</p>)}
    {collection && <section><h4>{collection.title || collection.id}</h4><p>Read-only · Native collection {collection.id}</p>{onBrowse && store && collectionProductsReadable(store) && <><button type="button" className="button" disabled={busy} onClick={browseProducts}>Use this collection as product filter</button>{selectedCollectionId === collection.id && <p role="status">Selected. Load the first product page above.</p>}</>}<dl>{([['Handle', collection.handle], ['Sort order', collection.sortOrder], ['Product count', collection.productCount], ['SEO title', collection.seo.title], ['SEO description', collection.seo.description], ['Updated', collection.updatedAt]] as [string, string | number | null][]).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value ?? 'Unknown'}</dd></React.Fragment>)}</dl><h5>Image</h5>{collection.image ? <p>Native image {collection.image.id ?? 'Unknown'} · URL: {collection.image.url} · Alt text: {collection.image.altText ?? 'Unknown'}</p> : <p>Image unknown</p>}<h5>Raw collection description HTML</h5><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{collection.descriptionHtml ?? 'Description HTML unknown'}</pre></section>}
  </section>;
}

export default function ZernioProducts({ request, onEdit, onCreate, onPrice, onDeactivate, onArchive, onActivate, onDeleteProduct, onRenameCollection }: { request: Request; onEdit?: (account: Account, store: Store, product: Product) => void; onCreate?: (account: Account, store: Store) => void; onPrice?: (account: Account, store: Store, product: Product) => void; onDeactivate?: (account: Account, store: Store, product: Product) => void; onArchive?: (account: Account, store: Store, product: Product) => void; onActivate?: (account: Account, store: Store, product: Product) => void; onDeleteProduct?: (account: Account, store: Store, product: Product) => void; onRenameCollection?: (account: Account, store: Store, collection: Collection) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]), [accountsLoaded, setAccountsLoaded] = useState(false), [retry, setRetry] = useState(0);
  const [accountId, setAccountId] = useState(''), [status, setStatus] = useState(''), [query, setQuery] = useState('');
  const [selectedCollection, setSelectedCollection] = useState<CollectionSelection | null>(null);
  const [collectionEpoch, setCollectionEpoch] = useState(0);
  const [store, setStore] = useState<Store | null>(null), [products, setProducts] = useState<Product[] | null>(null), [product, setProduct] = useState<Product | null>(null);
  const [nextCursor, setNextCursor] = useState(''), [page, setPage] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [stock, setStock] = useState<StockSnapshot | null>(null), [stockBusy, setStockBusy] = useState(false), [stockError, setStockError] = useState('');
  const requester = useRef(request), mounted = useRef(true), reads = useRef(0), cursors = useRef(new Set<string>());
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const identity = JSON.stringify([accountId, status, query, selectedCollection?.collection.id, selectedCollection && storeIdentity(selectedCollection.store)]), scope = useRef({ identity, pending: false }); if (scope.current.identity !== identity) scope.current = { identity, pending: false };
  const view = scope.current, current = () => mounted.current && scope.current === view, account = accounts.find(row => row.id === accountId);
  const collectionView = useMemo(() => ({}), [view, account]), committedCollection = useRef(collectionView);
  useLayoutEffect(() => { committedCollection.current = collectionView; }, [collectionView]);
  function chooseCollection(chosenAccount: Account, chosenStore: Store, collection: Collection) {
    if (!current() || committedCollection.current !== collectionView || !account || chosenAccount !== account || !account.isActive || account.needsReconnection || !readableStore(chosenStore, account.id) || !collectionProductsReadable(chosenStore) || !readableCollection(collection, account.id)) return;
    invalidate(); setSelectedCollection({ collection, store: chosenStore });
  }
  function allProducts() { if (current() && committedCollection.current === collectionView) { invalidate(); setSelectedCollection(null); } }
  const renameView = useMemo(() => ({}), [view, account, onRenameCollection]), committedRename = useRef(renameView);
  useLayoutEffect(() => { committedRename.current = renameView; }, [renameView]);
  function renameCollection(chosenAccount: Account, chosenStore: Store, collection: Collection) {
    if (current() && committedRename.current === renameView && !view.pending && account && chosenAccount === account && renameableCollection(account, chosenStore, collection)) onRenameCollection?.(account, chosenStore, collection);
  }
  const editView = useMemo(() => ({}), [onEdit, account, store, products, product]), committedEdit = useRef(editView);
  useLayoutEffect(() => { committedEdit.current = editView; }, [editView]);
  function edit(row: Product) { if (current() && committedEdit.current === editView && onEdit && account && store && editableProduct(account, store, row)) onEdit(account, store, row); }
  const createView = useMemo(() => ({}), [onCreate, account, store]), committedCreate = useRef(createView);
  useLayoutEffect(() => { committedCreate.current = createView; }, [createView]);
  function create() { if (current() && committedCreate.current === createView && onCreate && account && store && !view.pending && creatableProduct(account, store)) onCreate(account, store); }
  const priceView = useMemo(() => ({}), [onPrice, account, store, products, product]), committedPrice = useRef(priceView);
  useLayoutEffect(() => { committedPrice.current = priceView; }, [priceView]);
  function editPrice(row: Product) { if (current() && committedPrice.current === priceView && onPrice && account && store && !view.pending && priceableProduct(account, store, row)) onPrice(account, store, row); }
  const stateView = useMemo(() => ({}), [onDeactivate, onArchive, onActivate, onDeleteProduct, account, store, products, product]), committedState = useRef(stateView);
  useLayoutEffect(() => { committedState.current = stateView; }, [stateView]);
  function changeState(row: Product, action: 'deactivate' | 'archive' | 'activate' | 'delete') { const open = action === 'delete' ? onDeleteProduct : action === 'archive' ? onArchive : action === 'activate' ? onActivate : onDeactivate; if (current() && committedState.current === stateView && open && account && store && !view.pending && productStateAllowed(account, store, row, action)) open(account, store, row); }
  const stockView = useMemo(() => ({ pending: false }), [identity, account, store, product]), committedStock = useRef(stockView);
  useLayoutEffect(() => { committedStock.current = stockView; setStock(null); setStockBusy(false); setStockError(''); }, [stockView]);
  const currentStock = () => current() && committedStock.current === stockView;
  async function loadStock() {
    if (!currentStock() || view.pending || stockView.pending || !account || !store || !product || !stockableProduct(account, store, product)) return;
    stockView.pending = true; setStock(null); setStockBusy(true); setStockError('');
    try {
      const result = await requester.current(`products/${encodeURIComponent(account.id)}/${encodeURIComponent(product.id)}/inventory`);
      if (!currentStock()) return;
      setStock(stockSnapshot(result, account, store, product));
    } catch (failure) { if (currentStock()) { setStock(null); setStockError(failureMessage(failure)); } }
    finally { if (currentStock()) { stockView.pending = false; setStockBusy(false); } }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => {
    let active = true; setAccountsLoaded(false); setAccounts([]); setError('');
    requester.current('products/accounts').then(result => {
      if (!active) return;
      if (!Array.isArray(result?.accounts) || !result.accounts.every((row: any) => row && typeof row.id === 'string' && !!row.id && row.platform === 'shopify' && typeof row.name === 'string' && typeof row.isActive === 'boolean' && typeof row.needsReconnection === 'boolean') || new Set(result.accounts.map((row: Account) => row.id)).size !== result.accounts.length) throw new Error('Shopify accounts could not be verified.');
      setAccounts(result.accounts); setAccountsLoaded(true);
    }).catch(failure => { if (active) setError(failureMessage(failure)); });
    return () => { active = false; };
  }, [retry]);
  function clearResults() { setStore(null); setProducts(null); setProduct(null); setNextCursor(''); setPage(1); }
  function invalidate() { scope.current = { identity: '', pending: false }; reads.current++; cursors.current = new Set(); clearResults(); setBusy(false); setError(''); }
  function chooseAccount(value: string) { invalidate(); setSelectedCollection(null); setAccountId(value); }
  function changeFilter(name: 'status' | 'query', value: string) { invalidate(); if (name === 'status') setStatus(value); else setQuery(value); }
  async function load(kind: 'page' | 'detail' = 'page', cursor = '', productId = '') {
    if (!current() || view.pending || !account || !account.isActive || account.needsReconnection) return;
    const used = cursor ? new Set([...cursors.current, cursor]) : new Set<string>(), nextPage = cursor ? page + 1 : 1;
    view.pending = true; const read = ++reads.current; clearResults(); setBusy(true); setError('');
    try {
      if (query.length > 500 || status && !statuses.includes(status)) throw new Error('Use a query of at most 500 characters and a listed product status.');
      if (cursor && (cursor.length > 8192 || cursor !== nextCursor)) throw new Error('The requested page could not be verified. Load the first page again.');
      if (kind === 'detail' && !products?.some(row => row.id === productId)) throw new Error('Choose a product from the current page.');
      const target = `products/${encodeURIComponent(account.id)}`, storeResult = await requester.current(target + '/store');
      if (!current() || read !== reads.current) return;
      if (!readableStore(storeResult?.store, account.id)) throw new Error('The selected store could not be verified.');
      setStore(storeResult.store);
      if (!storeResult.store.capabilities.includes('products.read')) throw new Error('Product read permission is missing. Check the store permissions shown below.');
      if (selectedCollection && (storeIdentity(storeResult.store) !== storeIdentity(selectedCollection.store) || !collectionProductsReadable(storeResult.store))) throw new Error('The selected collection store and read permissions could not be verified. Read the collection again before choosing its product filter.');
      const params = new URLSearchParams({ limit: '20' }); if (cursor) params.set('cursor', cursor); if (status) params.set('status', status); if (query) params.set('query', query);
      if (selectedCollection) params.set('collectionId', selectedCollection.collection.id);
      const result = await requester.current(target + (kind === 'detail' ? '/' + encodeURIComponent(productId) : '?' + params.toString()));
      if (!current() || read !== reads.current) return;
      if (result?.coverage?.imagesLimit !== 20 || result?.coverage?.variantsLimit !== 100) throw new Error('Product coverage could not be verified.');
      if (kind === 'detail') {
        if (!readableProduct(result?.product, account.id) || result.product.id !== productId) throw new Error('The selected product could not be verified.');
        setProduct(result.product); cursors.current = new Set();
      } else {
        if (selectedCollection && (result?.accountId !== account.id || !readableStore(result?.store, account.id) || storeIdentity(result.store) !== storeIdentity(selectedCollection.store) || !collectionProductsReadable(result.store) || !readableCollection(result?.collection, account.id) || result.collection.id !== selectedCollection.collection.id)) throw new Error('The filtered product page, exact collection and store read permissions could not be verified. Read the collection again before choosing its product filter.');
        if (!Array.isArray(result?.products) || result.products.length > 20 || !result.products.every((row: unknown) => readableProduct(row, account.id)) || new Set(result.products.map((row: Product) => row.id)).size !== result.products.length) throw new Error('The product page could not be verified.');
        const next = pageCursor(result.nextCursor, used); cursors.current = used; setProducts(result.products); setNextCursor(next); setPage(nextPage);
      }
    } catch (failure) { if (current() && read === reads.current) { setProducts(null); setProduct(null); setNextCursor(''); cursors.current = new Set(); if (selectedCollection) { setSelectedCollection(null); setStore(null); setCollectionEpoch(value => value + 1); } setError(failureMessage(failure)); } }
    finally { if (current() && read === reads.current) { view.pending = false; setBusy(false); } }
  }
  const stockLocations = new Map(stock?.locations.map(row => [row.id, row] as const)), stockVariants = new Map(stock?.product.variants.map(row => [row.id, row] as const));
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Store and products</h2><p>Browse your connected Shopify store and product catalog.</p></div></div>
    <p className="helper-note">{onEdit || onCreate || onPrice ? 'Eligible product changes require review.' : 'Read-only.'} Search uses your platform query exactly as entered. URLs and descriptions are displayed as text.</p>
    {error && <p className="alert" role="alert">{error}</p>}{busy && <p role="status">Loading store content…</p>}
    <label className="field"><span>Shopify account</span><select value={accountId} onChange={event => chooseAccount(event.target.value)}><option value="">Choose Shopify</option>{accounts.map(row => <option key={row.id} value={row.id}>{row.name}{!row.isActive || row.needsReconnection ? ' · Reconnection required' : ''}</option>)}</select></label>
    {!accountsLoaded && <button type="button" className="button" onClick={() => { invalidate(); setAccountId(''); setRetry(value => value + 1); }}>Reload Shopify accounts</button>}{accountsLoaded && !accounts.length && <p>No Shopify account is connected to this project.</p>}
    {account && <>
      {(!account.isActive || account.needsReconnection) && <p className="alert">Reconnect this Shopify account before reading store products.</p>}
      {selectedCollection && <section aria-label="Product collection filter" className="helper-note"><p>Product listing filter: {selectedCollection.collection.title || selectedCollection.collection.id} · Native collection {selectedCollection.collection.id} · Store {selectedCollection.store.domain}</p><p>Load the first product page to apply this filter. Returned pages do not establish complete membership or publication.</p><button type="button" className="button" onClick={allProducts}>Return to all products</button></section>}
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void load(); }}>
        <Field label="Platform product query" name="query" type="search" maxLength={500} value={query} onChange={event => changeFilter('query', event.target.value)}/>
        <label className="field"><span>Product status</span><select value={status} onChange={event => changeFilter('status', event.target.value)}><option value="">Any status</option>{statuses.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
        <div className="button-wrap"><button type="submit" className="button" disabled={busy || !account.isActive || account.needsReconnection}>Load first page</button>{products !== null && <span>Page {page}</span>}{nextCursor && <button type="button" className="button" disabled={busy} onClick={() => load('page', nextCursor)}>Next page</button>}</div>
      </form>
      <CollectionsBrowser key={`${account.id}:${collectionEpoch}`} account={account} request={request} onBrowse={chooseCollection} onRename={onRenameCollection ? renameCollection : undefined} selectedCollectionId={selectedCollection?.collection.id}/>
    </>}
    {store && <section className="panel"><h3>{store.name || 'Shopify store'}</h3><dl><dt>Domain</dt><dd>{store.domain}</dd><dt>Store URL</dt><dd>{store.url ?? 'Not returned'}</dd><dt>Currency</dt><dd>{store.currency}</dd><dt>Country</dt><dd>{store.country ?? 'Not returned'}</dd><dt>Available permissions</dt><dd>{store.capabilities.join(', ') || 'None returned'}</dd><dt>Missing permissions</dt><dd>{store.missingCapabilities.join(', ') || 'None returned'}</dd>{store.grantPermissionsUrl && <><dt>Permission URL</dt><dd>{store.grantPermissionsUrl}</dd></>}</dl>{onCreate && account && creatableProduct(account, store) && <button type="button" className="button" disabled={busy} onClick={create}>New draft product</button>}</section>}
    {products !== null && <><p className="helper-note">Provider coverage is limited to the first 20 images and first 100 variants per product. These may be partial lists.</p>{products.length ? <div className="table-scroll"><table><thead><tr><th>Product</th><th>Status</th><th>Vendor</th><th>Action</th></tr></thead><tbody>{products.map(row => <tr key={row.id}><td>{row.title || row.id}</td><td>{row.status} · {row.platformStatus}</td><td>{row.vendor ?? 'Not returned'}</td><td><button type="button" className="button" disabled={busy} onClick={() => load('detail', '', row.id)}>Read {row.title || row.id}</button>{onEdit && account && store && editableProduct(account, store, row) && <button type="button" className="button" disabled={busy} onClick={() => edit(row)}>Edit product {row.title || row.id}</button>}{onPrice && account && store && priceableProduct(account, store, row) && <button type="button" className="button" disabled={busy} onClick={() => editPrice(row)}>Edit price {row.title || row.id}</button>}{onDeactivate && account && store && productStateAllowed(account, store, row) && <button type="button" className="button" disabled={busy} onClick={() => changeState(row, 'deactivate')}>Move to draft {row.title || row.id}</button>}{onArchive && account && store && productStateAllowed(account, store, row, 'archive') && <button type="button" className="button" disabled={busy} onClick={() => changeState(row, 'archive')}>Archive {row.title || row.id}</button>}{onActivate && account && store && productStateAllowed(account, store, row, 'activate') && <button type="button" className="button" disabled={busy} onClick={() => changeState(row, 'activate')}>Activate {row.title || row.id}</button>}{onDeleteProduct && account && store && productStateAllowed(account, store, row, 'delete') && <button type="button" className="button danger" disabled={busy} onClick={() => changeState(row, 'delete')}>Delete {row.title || row.id}</button>}</td></tr>)}</tbody></table></div> : <p>No products were returned for this page and these filters.</p>}</>}
    {product && <section className="panel"><h3>{product.title || product.id}</h3><p>Read-only · Product {product.id} · {product.status} · {product.platformStatus}</p>
      {onEdit && account && store && editableProduct(account, store, product) && <button type="button" className="button" disabled={busy} onClick={() => edit(product)}>Edit product {product.title || product.id}</button>}
      {onPrice && account && store && priceableProduct(account, store, product) && <button type="button" className="button" disabled={busy} onClick={() => editPrice(product)}>Edit price {product.title || product.id}</button>}
      {onDeactivate && account && store && productStateAllowed(account, store, product) && <button type="button" className="button" disabled={busy} onClick={() => changeState(product, 'deactivate')}>Move to draft {product.title || product.id}</button>}{onArchive && account && store && productStateAllowed(account, store, product, 'archive') && <button type="button" className="button" disabled={busy} onClick={() => changeState(product, 'archive')}>Archive {product.title || product.id}</button>}{onActivate && account && store && productStateAllowed(account, store, product, 'activate') && <button type="button" className="button" disabled={busy} onClick={() => changeState(product, 'activate')}>Activate {product.title || product.id}</button>}{onDeleteProduct && account && store && productStateAllowed(account, store, product, 'delete') && <button type="button" className="button danger" disabled={busy} onClick={() => changeState(product, 'delete')}>Delete {product.title || product.id}</button>}
      <section aria-label="Stock and locations"><h4>Stock and locations</h4><p className="helper-note">Read returned location quantities for this product.</p>{account && store && stockableProduct(account, store, product) ? <button type="button" className="button" disabled={busy || stockBusy} onClick={loadStock}>{stockBusy ? 'Loading stock and locations…' : stock ? 'Refresh stock and locations' : 'Load stock and locations'}</button> : <p>Stock reading requires a connected matching Shopify account and product read and inventory read permissions.</p>}
        {stockBusy && <p role="status">Loading stock and locations…</p>}{stockError && <p className="alert" role="alert">{stockError}</p>}
        {stock && <><p className="helper-note">Returned rows only. Inventory completeness: unknown. Location completeness: unknown. Product names cover only the first 100 variants; inventory may include other native variant IDs.</p><p>Loaded at {stock.loadedAt} (browser time). Provider freshness is unknown.</p><h5>Returned locations</h5>{stock.locations.length ? <div className="table-scroll"><table><thead><tr><th>Native location</th><th>Name</th><th>Active</th><th>Fulfills online orders</th><th>Address</th></tr></thead><tbody>{stock.locations.map(row => <tr key={row.id}><td>{row.id}</td><td>{row.name ?? 'Name not returned'}</td><td>{row.isActive === null ? 'Unknown' : row.isActive ? 'Yes' : 'No'}</td><td>{row.fulfillsOnlineOrders === null ? 'Unknown' : row.fulfillsOnlineOrders ? 'Yes' : 'No'}</td><td>{row.address === null ? 'Address unknown' : (['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode', 'phone'] as const).map(key => <p key={key}>{({ line1: 'Address line 1', line2: 'Address line 2', city: 'City', region: 'Region', postalCode: 'Postal code', countryCode: 'Country code', phone: 'Phone' } as Record<string, string>)[key]}: {row.address![key] ?? 'Unknown'}</p>)}</td></tr>)}</tbody></table></div> : <p>No location rows returned. Location completeness is unknown.</p>}<h5>Returned inventory</h5>{stock.inventory.length ? stock.inventory.map(row => { const variant = stockVariants.get(row.variantId); return <section key={row.variantId}><h6>Native variant {row.variantId}</h6><p>{variant ? variant.title : 'Variant name not returned within product coverage'} · SKU: {row.sku ?? 'Unknown'} · {row.tracked === null ? 'Tracking unknown' : row.tracked ? 'Tracked' : 'Untracked'}</p>{row.levels === null ? <p>Location levels unknown; no quantities were returned.</p> : row.levels.length ? <div className="table-scroll"><table><thead><tr><th>Native location</th><th>Location name</th><th>Available</th><th>On hand</th><th>Committed</th><th>Incoming</th></tr></thead><tbody>{row.levels.map(level => <tr key={level.locationId}><td>{level.locationId}</td><td>{stockLocations.get(level.locationId)?.name ?? 'Location name not returned'}</td><td>{level.available ?? 'Unknown'}</td><td>{level.onHand ?? 'Unknown'}</td><td>{level.committed ?? 'Unknown'}</td><td>{level.incoming ?? 'Unknown'}</td></tr>)}</tbody></table></div> : <p>No location level rows returned. Inventory completeness is unknown.</p>}</section>; }) : <p>No inventory rows returned. Inventory completeness is unknown.</p>}</>}
      </section>
      <dl>{([['Handle', product.handle], ['Vendor', product.vendor], ['Product type', product.productType], ['Product URL', product.url], ['Total inventory', product.totalInventory], ['SEO title', product.seo.title], ['SEO description', product.seo.description], ['Created', product.createdAt], ['Updated', product.updatedAt], ['Published', product.publishedAt]] as [string, string | number | null][]).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value ?? 'Not returned'}</dd></React.Fragment>)}</dl>
      <p>Tags: {product.tags.join(', ') || 'None returned'}</p><h4>Options</h4>{product.options.length ? product.options.map((option, index) => <p key={index}>{option.name}: {option.values.join(', ')}</p>) : <p>No options returned.</p>}
      {product.featuredImage && <p>Featured image URL: {product.featuredImage.url} · Alt text: {product.featuredImage.altText ?? 'Not returned'}</p>}
      <h4>Images</h4><p>Limited to the provider’s first 20 images. This may be a partial list.</p>{product.images.length ? <ul>{product.images.map((row, index) => <li key={index}>{row.url} · Alt text: {row.altText ?? 'Not returned'}</li>)}</ul> : <p>No images returned within provider coverage.</p>}
      <h4>Variants</h4><p>Limited to the provider’s first 100 variants. This may be a partial list. Amounts and currencies are shown exactly as returned.</p>{product.variants.length ? <div className="table-scroll"><table><thead><tr><th>Variant</th><th>SKU / barcode</th><th>Price</th><th>Compare-at price</th><th>Inventory</th><th>Available for sale</th><th>Options</th></tr></thead><tbody>{product.variants.map((row, index) => <tr key={index}><td>{row.title || row.id} · {row.id}</td><td>{row.sku ?? 'Not returned'} / {row.barcode ?? 'Not returned'}</td><td>{row.price.amount} {row.price.currency}</td><td>{row.compareAtPrice ? `${row.compareAtPrice.amount} ${row.compareAtPrice.currency}` : 'Not returned'}</td><td>{row.inventoryQuantity ?? 'Not returned'}</td><td>{row.availableForSale === null ? 'Not returned' : row.availableForSale ? 'Yes' : 'No'}</td><td>{row.options.map(option => `${option.name}: ${option.value}`).join(', ') || 'None returned'}</td></tr>)}</tbody></table></div> : <p>No variants returned within provider coverage.</p>}
      <h4>Raw description HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{product.descriptionHtml ?? 'No description HTML was returned.'}</pre>
    </section>}
  </section>;
}

type CollectionSnapshot = { resource: string; collection: Collection; store: Store; version: string };
type CollectionTitleAction = CollectionSnapshot & { safety: object; revision: number; title: string };
function collectionSnapshot(value: any, account: Account, store: Store, collection: Collection, resource: string): CollectionSnapshot {
  if (value?.accountId !== account.id || !readableCollection(value?.collection, account.id) || value.collection.id !== collection.id || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(store) || !renameableCollection(account, value.store, value.collection) || typeof value.version !== 'string' || !value.version) throw new Error('The exact collection, store and title editing permissions could not be verified. Refresh the current collection and review again.');
  return { resource, collection: value.collection, store: value.store, version: value.version };
}
function validateCollectionTitleReceipt(value: any, account: Account, action: CollectionTitleAction) {
  if (value?.accountId !== account.id || !readableCollection(value?.collection, account.id) || value.collection.id !== action.collection.id || value.collection.title !== action.title || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(action.store) || !renameableCollection(account, value.store, value.collection) || value.readback !== true || value.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id) throw new Error('The collection title receipt could not be verified. Check the outcome of the same action before making another change.');
}

export function CollectionTitleEditor({ account, store, collection, request, readOnly = false }: { account: Account; store: Store; collection: Collection; request: Request; readOnly?: boolean }) {
  const [title, setTitle] = useState(''), [snapshot, setSnapshot] = useState<CollectionSnapshot | null>(null), [review, setReview] = useState<CollectionTitleAction | null>(null), [unknown, setUnknown] = useState<CollectionTitleAction | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<any>(null), [closed, setClosed] = useState<{ id?: string; status?: string; notSent?: boolean } | null>(null);
  const resource = JSON.stringify([account.id, account.platform, store.accountId, store.platform, store.domain, store.url, collection.id, collection.accountId, collection.platform]), writable = !readOnly && renameableCollection(account, store, collection);
  const identity = JSON.stringify([resource, account, storeIdentity(store), collection, writable]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity, account, store, collection]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<CollectionTitleAction | null>(null), recovery = useRef<CollectionTitleAction | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; revision.current++; confirmation.current = null; setSnapshot(null); setReview(null); setConfirmed(false); }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, ready = snapshot?.resource === resource, target = `products/${encodeURIComponent(account.id)}/collections/${encodeURIComponent(collection.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { recovery.current = null; setTitle(''); setSnapshot(null); setReview(null); setUnknown(null); setConfirmed(false); setBusy(false); setError(''); setSaved(null); setClosed(null); if (writable) void loadCollection(true); }, [resource]);
  function change(value: string) {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || unknown || saved) return;
    revision.current++; confirmation.current = null; setTitle(value); setReview(null); setConfirmed(false); setError('');
  }
  async function loadCollection(initial = false) {
    if (!current() || !writable || view.pending || !initial && (unknown || saved)) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setSnapshot(null); setReview(null); setConfirmed(false); setError('');
    try {
      const fresh = collectionSnapshot(await requester.current(target + '/edit'), account, store, collection, resource);
      if (!current() || read !== revision.current) return;
      setSnapshot(fresh); if (initial) setTitle(fresh.collection.title);
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || unknown || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const value = title.trim();
      if (!value || value.length > 10000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Enter a collection title of 1–10,000 characters without control characters.');
      if (value === snapshot.collection.title) throw new Error('Change the collection title before reviewing.');
      const fresh = collectionSnapshot(await requester.current(target + '/edit'), account, store, collection, resource);
      if (!current() || read !== revision.current) return;
      if (fresh.version !== snapshot.version) { setSnapshot(null); throw new Error('This collection changed on Shopify. Your title was kept. Refresh the current collection and review again.'); }
      setReview({ ...fresh, safety, revision: read, title: value });
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const action = unknown || review;
    if (!current() || !writable || view.pending || saved || !action || action.resource !== resource || storeIdentity(action.store) !== storeIdentity(store) || (unknown ? recovery.current !== action : !ready || action.safety !== safety || action.revision !== revision.current || confirmation.current !== action || !confirmed)) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: action.version, title: action.title }, validate = (value: any) => validateCollectionTitleReceipt(value, account, action);
      const result = await requester.current(target + '/rename', body, validate, !!unknown); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; recovery.current = null; setSaved(result); setReview(null); setUnknown(null); setConfirmed(false);
    } catch (failure) {
      if (sameDestination()) {
        const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } };
        setError(problem.message || 'The collection title change could not be confirmed.'); confirmation.current = null; setReview(null); setConfirmed(false);
        if (productRequestNotSent(problem)) { revision.current++; recovery.current = null; setClosed({ notSent: true }); setSnapshot(null); setUnknown(null); }
        else if (problem.code === 'OPERATION_REVIEWED') { revision.current++; recovery.current = null; setClosed(problem.operation || {}); setSnapshot(null); setUnknown(null); }
        else if (unknown || !problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) { recovery.current = action; setUnknown(action); }
        else setSnapshot(null);
      }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={rename}>
    <p>Shopify · {account.name} · Account {account.id} · {store.name} · {store.domain} · Native collection {collection.id}</p><p className="helper-note">Rename this collection’s title. Saving can change the live storefront immediately. Other returned collection metadata remains read-only; completeness, membership and publication are unknown.</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">Renaming requires a connected matching Shopify account and collection read and write permissions.</p>}
    {closed && <p className="helper-note" role="status">{closed.notSent ? 'Earlier request was not sent. Refresh the current collection and review a new action.' : <>The prior action is closed after operator review · {closed.id ?? 'Operation ID unavailable'} · {closed.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Your title was kept. Refresh the current collection and review a new action.</>}</p>}
    {writable && !saved && !unknown && <button type="button" className="button" disabled={busy} onClick={() => loadCollection()}>Refresh current collection review</button>}
    {!ready && writable && !unknown && !saved && <p role="status">{busy ? 'Loading current collection…' : 'Load and verify the current collection before reviewing.'}</p>}
    {ready && <p>Current collection title: {snapshot.collection.title}</p>}
    <fieldset disabled={busy || !!unknown || !!saved || !writable || !ready}><Field label="Collection title" name="title" maxLength={10000} value={title} onChange={event => change(event.target.value)}/><button type="button" className="button" onClick={prepare}>Review collection title</button></fieldset>
    {review && review.revision === revision.current && review.safety === safety && <section className="helper-note"><h3>Review Shopify collection title</h3><p>{account.name} · Account {account.id} · {review.store.name} · {review.store.domain} · Store URL {review.store.url ?? 'Not returned'} · Native collection {review.collection.id}</p><p>Before: {review.collection.title}</p><p>After: {review.title}</p><label className="checkbox-label"><input type="checkbox" name="confirmRename" checked={confirmed} disabled={busy || !writable} onChange={event => { if (!current() || !writable || view.pending || unknown || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>I reviewed this exact account, store, native collection and before/after title. I understand saving can change the live storefront immediately.</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable}>Save collection title</button></section>}
    {unknown && <Alert title="Outcome unknown" tone="warning" role="status"><div className="t98-settings-fields"><p>The outcome is unknown. Your title and original action are retained. Check outcome uses the same action; it is never retried automatically.</p><p>Account {account.id} · {unknown.store.domain} · Native collection {unknown.collection.id} · Before: {unknown.collection.title} · After: {unknown.title}</p><button type="submit" className="button" disabled={busy || !writable || storeIdentity(unknown.store) !== storeIdentity(store)}>{busy ? 'Checking outcome…' : 'Check outcome'}</button></div></Alert>}
    {saved && <section className="helper-note" role="status"><p>Collection title confirmed by Shopify readback · Account {saved.accountId} · {saved.store.domain} · Native collection {saved.collection.id}</p><p>Accepted title: {saved.collection.title}</p></section>}
  </form>;
}

type ProductSnapshot = { resource: string; product: Product; store: Store; version: string };
type ProductReview = ProductSnapshot & { safety: object; revision: number; fields: { title?: string; descriptionHtml?: string; vendor?: string; productType?: string; tags?: string[] } };
function productChanges(before: Product, title: string, descriptionHtml: string | null, vendor: string | null, productType: string | null, tags: string[]) {
  const fields: ProductReview['fields'] = {};
  if (title !== before.title && title.trim() !== before.title) {
    const value = title.trim();
    if (!value || value.length > 10000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Enter a title of 1–10,000 characters without control characters.');
    fields.title = value;
  }
  if (descriptionHtml !== null && descriptionHtml !== before.descriptionHtml) {
    if (descriptionHtml.length > 1000000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(descriptionHtml)) throw new Error('Product HTML must be at most 1,000,000 characters without unsupported control characters.');
    fields.descriptionHtml = descriptionHtml;
  }
  if (vendor !== null && vendor !== before.vendor) {
    if (vendor.length > 10000 || /[\u0000-\u001f\u007f-\u009f]/.test(vendor)) throw new Error('Vendor must be at most 10,000 characters without control characters. An empty value clears the vendor.');
    fields.vendor = vendor;
  }
  if (productType !== null && productType !== before.productType) {
    if (productType.length > 10000 || /[\u0000-\u001f\u007f-\u009f]/.test(productType)) throw new Error('Product type must be at most 10,000 characters without control characters. An empty value sends an empty string.');
    fields.productType = productType;
  }
  if (!sameTags(tags, before.tags)) {
    if (tags.length > 1000 || tags.some(value => value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value))) throw new Error('Use at most 1,000 tags, each at most 2,000 characters without unsupported control characters.');
    fields.tags = tags;
  }
  if (!Object.keys(fields).length) throw new Error('Change the product title, description HTML, vendor, product type or tags before reviewing.');
  return fields;
}
function productSnapshot(value: any, account: Account, store: Store, product: Product, resource: string): ProductSnapshot {
  if (!readableProduct(value?.product, account.id) || value.product.id !== product.id || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(store) || !editableProduct(account, value.store, value.product) || typeof value.version !== 'string' || !value.version) throw new Error('The exact product, store and editing permissions could not be verified. Reopen the editor after refreshing products.');
  return { resource, product: value.product, store: value.store, version: value.version };
}
function validateProductReceipt(value: any, account: Account, review: ProductReview) {
  if (value?.accountId !== account.id || !readableProduct(value?.product, account.id) || value.product.id !== review.product.id || value.product.status === 'deleted' || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(review.store) || value.readback !== true || value.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id || review.fields.title !== undefined && value.product.title !== review.fields.title || review.fields.descriptionHtml !== undefined && (typeof value.product.descriptionHtml !== 'string' || value.product.descriptionHtml.length > 1000000) || review.fields.vendor !== undefined && value.product.vendor !== review.fields.vendor || review.fields.productType !== undefined && value.product.productType !== review.fields.productType || review.fields.tags !== undefined && !sameTags(value.product.tags, review.fields.tags)) throw new Error('The product update receipt could not be verified. Check the same action before making another change.');
}

export function ProductEditor({ account, store, product, request, readOnly = false }: { account: Account; store: Store; product: Product; request: Request; readOnly?: boolean }) {
  const [title, setTitle] = useState(''), [descriptionHtml, setDescriptionHtml] = useState<string | null>(null), [vendor, setVendor] = useState<string | null>(null), [productType, setProductType] = useState<string | null>(null), [tags, setTags] = useState<string[]>([]), [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [review, setReview] = useState<ProductReview | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<any>(null);
  const [closed, setClosed] = useState<{ operation?: { id?: string; status?: string }; review: ProductReview; notSent?: boolean } | null>(null);
  const resource = JSON.stringify([account.id, account.platform, store.accountId, store.platform, store.domain, store.url, product.id, product.accountId, product.platform]), writable = !readOnly && editableProduct(account, store, product);
  const identity = JSON.stringify([resource, account, storeIdentity(store), product, writable]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<ProductReview | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; if (!view.pending && !uncertain) { confirmation.current = null; setReview(null); setConfirmed(false); } }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, ready = snapshot?.resource === resource, target = `products/${encodeURIComponent(account.id)}/${encodeURIComponent(product.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { revision.current++; confirmation.current = null; setTitle(''); setDescriptionHtml(null); setVendor(null); setProductType(null); setTags([]); setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setUncertain(false); setError(''); setSaved(null); setClosed(null); if (writable) void loadProduct(true); }, [resource]);
  function change(field: 'title' | 'descriptionHtml' | 'vendor' | 'productType' | 'tags', value: string | string[]) {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || uncertain || saved) return;
    revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setError(''); if (field === 'tags' && Array.isArray(value)) setTags(value); else if (typeof value === 'string') { if (field === 'title') setTitle(value); else if (field === 'descriptionHtml') setDescriptionHtml(value); else if (field === 'vendor') setVendor(value); else if (field === 'productType') setProductType(value); }
  }
  async function loadProduct(initial = false) {
    if (!current() || !writable || view.pending || !initial && (uncertain || saved || ready)) return;
    const read = ++revision.current; view.pending = true; setBusy(true); setError('');
    try {
      const result = productSnapshot(await requester.current(target), account, store, product, resource);
      if (!current() || read !== revision.current) return;
      setSnapshot(result); if (closed?.review.resource !== resource) { setTitle(result.product.title); setDescriptionHtml(result.product.descriptionHtml); setVendor(result.product.vendor); setProductType(result.product.productType); setTags(result.product.tags); }
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || uncertain || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const fields = productChanges(snapshot.product, title, descriptionHtml, vendor, productType, tags), fresh = productSnapshot(await requester.current(target), account, store, product, resource);
      if (!current() || read !== revision.current) return;
      if (fresh.version !== snapshot.version) throw new Error('This product changed on Shopify. Your edits were kept. Close and reopen the editor to load its current content.');
      setReview({ ...fresh, safety, revision: read, fields });
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || !writable || !ready || view.pending || saved || !review || review.resource !== resource || review.revision !== revision.current || !uncertain && review.safety !== safety || confirmation.current !== review || !confirmed) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: review.version, confirmUpdate: true, ...review.fields }, validate = (value: any) => validateProductReceipt(value, account, review);
      const result = await requester.current(target + '/update', body, validate, uncertain); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; setSaved(result); setReview(null); setConfirmed(false); setUncertain(false);
    } catch (failure) {
      if (sameDestination()) { const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } }; setError(problem.message || 'The product update could not be confirmed.'); if (productRequestNotSent(problem)) { revision.current++; confirmation.current = null; setClosed({ review, notSent: true }); setSnapshot(null); setReview(null); setConfirmed(false); setUncertain(false); } else if (problem.code === 'OPERATION_REVIEWED') { revision.current++; confirmation.current = null; setClosed({ operation: problem.operation, review }); setSnapshot(null); setReview(null); setConfirmed(false); setUncertain(false); } else if (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) setUncertain(true); else { confirmation.current = null; setReview(null); setConfirmed(false); } }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={update}>
    <p>Shopify · {account.name} · Account {account.id} · {store.name} · {store.domain} · Product {product.id}</p><p className="helper-note">Edit this product’s title, description HTML, vendor, product type and complete tag list. Saving can change your live storefront immediately.</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">Editing requires a connected matching Shopify account and product read and update permissions.</p>}
    {closed && <p className="helper-note" role="status">{closed.notSent ? productNotSentMessage : <>The prior action is closed after operator review · {closed.operation?.id ?? 'Operation ID unavailable'} · {closed.operation?.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Your edits are kept. Refresh the current product and review a new action before saving again.</>}</p>}
    {!ready && writable && <><p role="status">{busy ? 'Loading current product…' : 'Load and verify the current product before editing.'}</p><button type="button" className="button" disabled={busy} onClick={() => loadProduct()}>{closed ? 'Refresh current product review' : 'Reload current product'}</button></>}
    <fieldset disabled={busy || uncertain || !!saved || !writable || !ready}>
      <Field label="Product title" name="title" maxLength={10000} value={title} onChange={event => change('title', event.target.value)}/>
      {descriptionHtml === null ? <><p className="field-help">Description HTML was not returned. Leave it untouched, or explicitly replace it. An empty replacement clears the description.</p><button type="button" className="button" onClick={() => change('descriptionHtml', '')}>Replace unavailable description HTML</button></> : <Field label="Description HTML" name="descriptionHtml" multiline maxLength={1000000} value={descriptionHtml} onChange={event => change('descriptionHtml', event.target.value)}/>}
      {vendor === null ? <><p className="field-help">Vendor was not returned. Leave it untouched, or explicitly replace it. An empty replacement clears the vendor.</p><button type="button" className="button" onClick={() => change('vendor', '')}>Replace unavailable vendor</button></> : <><Field label="Vendor" name="vendor" maxLength={10000} value={vendor} onChange={event => change('vendor', event.target.value)}/><p className="field-help">An empty value clears the vendor.</p></>}
      {productType === null ? <><p className="field-help">Product type was not returned. Leave it untouched, or explicitly replace it. An empty replacement sends an empty string.</p><button type="button" className="button" onClick={() => change('productType', '')}>Replace unavailable product type</button></> : <><Field label="Product type" name="productType" maxLength={10000} value={productType} onChange={event => change('productType', event.target.value)}/><p className="field-help">An empty value sends an empty string.</p></>}
      <p className="field-help">Tags replace the complete list. Each box is one exact tag; commas, case and spaces are kept. Shopify may return tags in a different order. Clearing the list removes all tags.</p>
      {tags.map((tag, index) => <div key={index}><Field label={`Tag ${index + 1}`} name={`tag-${index + 1}`} multiline maxLength={2000} value={tag} onChange={event => change('tags', tags.map((value, position) => position === index ? event.target.value : value))}/><button type="button" className="button" onClick={() => change('tags', tags.filter((_value, position) => position !== index))}>Remove tag {index + 1}</button></div>)}
      <button type="button" className="button" disabled={tags.length >= 1000} onClick={() => change('tags', [...tags, ''])}>Add tag</button><button type="button" className="button" disabled={!tags.length} onClick={() => change('tags', [])}>Clear all tags</button>
      <p className="field-help">HTML and image URLs remain text here. HTML is never rendered.</p><button type="button" className="button" onClick={prepare}>Review product changes</button>
    </fieldset>
    {review && review.revision === revision.current && (review.safety === safety || uncertain) && <section className="helper-note">
      <h3>Review Shopify product update</h3><p>{account.name} · Account {account.id} · {review.store.name} · {review.store.domain} · Store URL {review.store.url ?? 'Not returned'} · Native product {review.product.id} · {review.product.status} · {review.product.platformStatus}</p>
      <h4>Before</h4><p>Title: {review.product.title}</p><p>Vendor: {review.product.vendor === null ? 'Not returned' : review.product.vendor || '(empty)'}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Product type: {review.product.productType === null ? 'Not returned' : JSON.stringify(review.product.productType)}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Tags: {JSON.stringify(review.product.tags)}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.product.descriptionHtml ?? 'Description HTML was not returned.'}</pre>
      <h4>After</h4><p>Title: {review.fields.title ?? review.product.title}{review.fields.title === undefined ? ' (unchanged)' : ''}</p><p>Vendor: {review.fields.vendor !== undefined ? review.fields.vendor || '(clear vendor)' : review.product.vendor ?? 'Not returned'}{review.fields.vendor === undefined ? ' (unchanged)' : ''}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Product type: {review.fields.productType !== undefined ? JSON.stringify(review.fields.productType) : review.product.productType === null ? 'Not returned' : JSON.stringify(review.product.productType)}{review.fields.productType === undefined ? ' (unchanged)' : review.fields.productType === '' ? ' (empty string)' : ''}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Tags: {JSON.stringify(review.fields.tags ?? review.product.tags)}{review.fields.tags === undefined ? ' (unchanged)' : ''}</pre>{review.fields.tags?.length === 0 && <p>All tags will be cleared. The complete replacement list is empty.</p>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.fields.descriptionHtml ?? review.product.descriptionHtml ?? 'Description HTML unchanged; current HTML is unknown.'}</pre>
      <p>Changes: {Object.keys(review.fields).map(key => key === 'title' ? 'Title' : key === 'vendor' ? 'Vendor' : key === 'productType' ? 'Product type' : key === 'tags' ? 'Tags' : 'Description HTML').join(', ')}. Shopify may normalize description HTML.</p><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={busy || uncertain || !writable} onChange={event => { if (!current() || !writable || view.pending || uncertain || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>I reviewed this exact account, store, native product and before/after content. I understand saving can change the live storefront immediately.</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable}>{busy ? 'Checking product update…' : uncertain ? 'Check the same product update' : 'Save product changes'}</button>
    </section>}
    {uncertain && <p className="alert" role="status">The outcome is unknown. Your content and original action are retained. Check the same product update before editing again; it is never retried automatically.</p>}
    {saved && <section className="helper-note" role="status"><p>Product update confirmed by Shopify readback · Account {saved.accountId} · {saved.store.domain} · Product {saved.product.id}. The accepted canonical content is shown below; Shopify may have normalized HTML.</p><p>Accepted title: {saved.product.title}</p><p>Accepted vendor: {saved.product.vendor === null ? 'Not returned' : saved.product.vendor || '(empty)'}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Accepted product type: {saved.product.productType === null ? 'Not returned' : JSON.stringify(saved.product.productType)}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Accepted tags: {JSON.stringify(saved.product.tags)}</pre><h4>Accepted description HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.product.descriptionHtml ?? 'Description HTML was not returned.'}</pre></section>}
  </form>;
}

type ProductCreationReview = { resource: string; store: Store; version: string; safety: object; revision: number; fields: { title: string; descriptionHtml?: string; price: string } };
function productCreationFields(title: string, descriptionHtml: string, price: string) {
  const value = title.trim();
  if (!value || value.length > 10000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Enter a title of 1–10,000 characters without control characters.');
  if (descriptionHtml.length > 1000000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(descriptionHtml)) throw new Error('Product HTML must be at most 1,000,000 characters without unsupported control characters.');
  if (price.length > 100 || price !== price.trim() || !/^\d+(?:\.\d{1,2})?$/.test(price)) throw new Error('Enter a nonnegative decimal price with up to two decimal places, without currency symbols, spaces or exponent notation.');
  return { title: value, ...(descriptionHtml === '' ? {} : { descriptionHtml }), price };
}
const decimalIdentity = (value: string) => value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
function validateProductCreationReceipt(value: any, account: Account, review: ProductCreationReview) {
  const row = value?.product;
  if (value?.accountId !== account.id || !readableProduct(row, account.id) || row.id.length > 500 || /[\u0000-\u001f\u007f-\u009f\s/?#]/.test(row.id) || ['.', '..'].includes(row.id) || row.status !== 'draft' || row.platformStatus !== 'DRAFT' || row.url !== null || row.publishedAt !== null || row.title !== review.fields.title || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(review.store) || !creatableProduct(account, value.store) || value.readback !== true || value.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id || row.variants.length !== 1 || row.variants[0].price.currency !== review.store.currency || row.variants[0].price.amount.length > 100 || !/^\d+(?:\.\d+)?$/.test(row.variants[0].price.amount) || decimalIdentity(row.variants[0].price.amount) !== decimalIdentity(review.fields.price) || review.fields.descriptionHtml !== undefined && typeof row.descriptionHtml !== 'string' || row.descriptionHtml !== null && (row.descriptionHtml.length > 1000000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(row.descriptionHtml))) throw new Error('The draft product receipt could not be verified. Check the same action before creating another product.');
}

export function ProductCreator({ account, store, request, readOnly = false }: { account: Account; store: Store; request: Request; readOnly?: boolean }) {
  const [title, setTitle] = useState(''), [descriptionHtml, setDescriptionHtml] = useState(''), [price, setPrice] = useState('');
  const [review, setReview] = useState<ProductCreationReview | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<any>(null);
  const [closed, setClosed] = useState<{ id?: string; status?: string; notSent?: boolean } | null>(null);
  const resource = JSON.stringify([account.id, account.platform, store.accountId, store.platform, store.domain, store.url]), writable = !readOnly && creatableProduct(account, store);
  const identity = JSON.stringify([resource, account, storeIdentity(store), writable]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<ProductCreationReview | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; if (!view.pending && !uncertain) { confirmation.current = null; setReview(null); setConfirmed(false); } }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, target = `products/${encodeURIComponent(account.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { confirmation.current = null; setTitle(''); setDescriptionHtml(''); setPrice(''); setReview(null); setConfirmed(false); setBusy(false); setUncertain(false); setError(''); setSaved(null); setClosed(null); }, [resource]);
  function change(field: 'title' | 'descriptionHtml' | 'price', value: string) {
    if (!current() || draftRevision !== revision.current || !writable || view.pending || uncertain || saved) return;
    revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setError(''); if (field === 'title') setTitle(value); else if (field === 'descriptionHtml') setDescriptionHtml(value); else setPrice(value);
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || view.pending || uncertain || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const fields = productCreationFields(title, descriptionHtml, price), fresh = await requester.current(target + '/store');
      if (!current() || read !== revision.current) return;
      if (!readableStore(fresh?.store, account.id) || storeIdentity(fresh.store) !== storeIdentity(store) || !creatableProduct(account, fresh.store) || typeof fresh.creationVersion !== 'string' || !fresh.creationVersion) throw new Error('The exact store and product creation permissions could not be verified. Refresh products and reopen the draft. Your content is kept.');
      setReview({ resource, store: fresh.store, version: fresh.creationVersion, safety, revision: read, fields });
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || !writable || view.pending || saved || !review || review.resource !== resource || review.revision !== revision.current || !uncertain && review.safety !== safety || confirmation.current !== review || !confirmed) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: review.version, confirmCreate: true, ...review.fields }, validate = (value: any) => validateProductCreationReceipt(value, account, review);
      const result = await requester.current(target + '/create', body, validate, uncertain); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; setSaved(result); setReview(null); setConfirmed(false); setUncertain(false);
    } catch (failure) {
      if (sameDestination()) { const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } }; setError(problem.message || 'The draft product creation could not be confirmed.'); if (productRequestNotSent(problem)) { revision.current++; confirmation.current = null; setClosed({ notSent: true }); setReview(null); setConfirmed(false); setUncertain(false); } else if (problem.code === 'OPERATION_REVIEWED') { revision.current++; confirmation.current = null; setClosed(problem.operation || {}); setReview(null); setConfirmed(false); setUncertain(false); } else if (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) setUncertain(true); else { confirmation.current = null; setReview(null); setConfirmed(false); } }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={create}>
    <p>Shopify · {account.name} · Account {account.id} · {store.name} · {store.domain}</p><p className="helper-note">Create one draft product with a single price in {store.currency}. Review the current store before confirming creation.</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">Creating a draft requires a connected matching Shopify account and product read and create permissions.</p>}
    {closed && <p className="helper-note" role="status">{closed.notSent ? productNotSentMessage : <>The prior action is closed after operator review · {closed.id ?? 'Operation ID unavailable'} · {closed.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Your content is kept. Review the current store and confirm a new action before creating again.</>}</p>}
    <fieldset disabled={busy || uncertain || !!saved || !writable}><Field label="Product title" name="title" maxLength={10000} value={title} onChange={event => change('title', event.target.value)}/><Field label="Description HTML" name="descriptionHtml" multiline maxLength={1000000} value={descriptionHtml} onChange={event => change('descriptionHtml', event.target.value)}/><Field label={`Price in ${store.currency}`} name="price" type="text" inputMode="decimal" maxLength={100} value={price} onChange={event => change('price', event.target.value)}/><p className="field-help">Enter the decimal price using a period and up to two decimal places. HTML stays literal text here and Shopify may normalize it.</p><button type="button" className="button" onClick={prepare}>{busy ? 'Reviewing store…' : 'Review draft product'}</button></fieldset>
    {review && review.revision === revision.current && (review.safety === safety || uncertain) && <section className="helper-note"><h3>Review Shopify draft product</h3><p>{account.name} · Account {account.id} · {review.store.name} · {review.store.domain} · Store URL {review.store.url ?? 'Not returned'} · Currency {review.store.currency}</p><p>Status: draft · DRAFT</p><p>Title: {review.fields.title}</p><h4>Description HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.fields.descriptionHtml ?? 'No description HTML supplied.'}</pre><p>Single variant price: {review.fields.price} {review.store.currency}</p><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={busy || uncertain || !writable} onChange={event => { if (!current() || !writable || view.pending || uncertain || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>I reviewed this exact account, store, title, description HTML and single price. Create this product as a draft.</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable}>{busy ? 'Checking draft product…' : uncertain ? 'Check the same draft product' : 'Create draft product'}</button></section>}
    {uncertain && <p className="alert" role="status">The outcome is unknown. Your content and original action are retained. Check the same draft product before creating again; it is never retried automatically.</p>}
    {saved && <section className="helper-note" role="status"><p>Draft product creation confirmed by Shopify readback · Account {saved.accountId} · {saved.store.domain} · Native product {saved.product.id} · {saved.product.status} · {saved.product.platformStatus}</p><p>Accepted title: {saved.product.title}</p><p>Accepted single variant price: {saved.product.variants[0].price.amount} {saved.product.variants[0].price.currency}</p><h4>Accepted description HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.product.descriptionHtml ?? 'No description HTML returned.'}</pre></section>}
  </form>;
}

type ProductPriceReview = ProductSnapshot & { safety: object; revision: number; variant: Variant; price: string };
const nativeVariantId = (value: string) => !!value && value.length <= 500 && !/[\u0000-\u001f\u007f-\u009f\s/?#]/.test(value) && !['.', '..'].includes(value);
function productPriceSnapshot(value: any, account: Account, store: Store, product: Product, resource: string): ProductSnapshot {
  if (!readableProduct(value?.product, account.id) || value.product.id !== product.id || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(store) || !priceableProduct(account, value.store, value.product) || typeof value.version !== 'string' || !value.version || new Set(value.product.variants.map((row: Variant) => row.id)).size !== value.product.variants.length || value.product.variants.some((row: Variant) => !nativeVariantId(row.id) || row.price.currency !== store.currency || row.price.amount.length > 100 || row.price.amount !== row.price.amount.trim() || !/^\d+(?:\.\d+)?$/.test(row.price.amount))) throw new Error('The exact product, store, variants and price permissions could not be verified. Refresh products and reopen the price editor.');
  return { resource, product: value.product, store: value.store, version: value.version };
}
function validateProductPriceReceipt(value: any, account: Account, review: ProductPriceReview) {
  const row = readableProduct(value?.product, account.id) ? value.product.variants.filter((variant: Variant) => variant.id === review.variant.id) : [];
  if (value?.accountId !== account.id || !readableProduct(value?.product, account.id) || value.product.id !== review.product.id || value.product.status === 'deleted' || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(review.store) || !priceableProduct(account, value.store, value.product) || value.readback !== true || value.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id || row.length !== 1 || row[0].price.currency !== review.store.currency || row[0].price.amount.length > 100 || row[0].price.amount !== row[0].price.amount.trim() || !/^\d+(?:\.\d+)?$/.test(row[0].price.amount) || decimalIdentity(row[0].price.amount) !== decimalIdentity(review.price)) throw new Error('The variant price receipt could not be verified. Check the same action before changing another price.');
}

export function ProductPriceEditor({ account, store, product, request, readOnly = false }: { account: Account; store: Store; product: Product; request: Request; readOnly?: boolean }) {
  const [variantId, setVariantId] = useState(''), [price, setPrice] = useState(''), [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [review, setReview] = useState<ProductPriceReview | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<any>(null);
  const [closed, setClosed] = useState<{ id?: string; status?: string; notSent?: boolean } | null>(null);
  const resource = JSON.stringify([account.id, account.platform, store.accountId, store.platform, store.domain, store.url, product.id, product.accountId, product.platform]), writable = !readOnly && priceableProduct(account, store, product);
  const identity = JSON.stringify([resource, account, storeIdentity(store), product, writable]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<ProductPriceReview | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; if (!view.pending && !uncertain) { confirmation.current = null; setReview(null); setConfirmed(false); } }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, ready = snapshot?.resource === resource, variant = ready ? snapshot.product.variants.find(row => row.id === variantId) : undefined, target = `products/${encodeURIComponent(account.id)}/${encodeURIComponent(product.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { confirmation.current = null; setVariantId(''); setPrice(''); setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setUncertain(false); setError(''); setSaved(null); setClosed(null); if (writable) void loadProduct(true); }, [resource]);
  function change(field: 'variantId' | 'price', value: string) {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || uncertain || saved) return;
    revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setError(''); if (field === 'variantId') setVariantId(value); else setPrice(value);
  }
  async function loadProduct(initial = false) {
    if (!current() || !writable || view.pending || !initial && (uncertain || saved)) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const fresh = productPriceSnapshot(await requester.current(target), account, store, product, resource);
      if (!current() || read !== revision.current) return;
      setSnapshot(fresh);
    } catch (failure) { if (current() && read === revision.current) { setSnapshot(null); setError(failureMessage(failure)); } }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || uncertain || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      if (!variant) throw new Error('Choose a returned variant from the current product.');
      if (price.length > 100 || price !== price.trim() || !/^\d+(?:\.\d{1,2})?$/.test(price)) throw new Error('Enter a nonnegative decimal price with up to two decimal places, without currency symbols, spaces or exponent notation.');
      if (decimalIdentity(price) === decimalIdentity(variant.price.amount)) throw new Error('Change the selected variant price before reviewing.');
      const fresh = productPriceSnapshot(await requester.current(target), account, store, product, resource);
      if (!current() || read !== revision.current) return;
      if (fresh.version !== snapshot.version) throw new Error('This product changed on Shopify. Your price is kept. Refresh current product prices and review again.');
      const selected = fresh.product.variants.find(row => row.id === variantId);
      if (!selected) throw new Error('The selected variant is no longer in the returned product coverage. Refresh current product prices.');
      setReview({ ...fresh, safety, revision: read, variant: selected, price });
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || !writable || !ready || view.pending || saved || !review || review.resource !== resource || review.revision !== revision.current || !uncertain && review.safety !== safety || confirmation.current !== review || !confirmed) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: review.version, confirmPrice: true, variantId: review.variant.id, price: review.price }, validate = (value: any) => validateProductPriceReceipt(value, account, review);
      const result = await requester.current(target + '/price', body, validate, uncertain); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; setSaved({ ...result, variantId: review.variant.id }); setReview(null); setConfirmed(false); setUncertain(false);
    } catch (failure) {
      if (sameDestination()) { const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } }; setError(problem.message || 'The variant price change could not be confirmed.'); if (productRequestNotSent(problem)) { revision.current++; confirmation.current = null; setClosed({ notSent: true }); setSnapshot(null); setReview(null); setConfirmed(false); setUncertain(false); } else if (problem.code === 'OPERATION_REVIEWED') { revision.current++; confirmation.current = null; setClosed(problem.operation || {}); setSnapshot(null); setReview(null); setConfirmed(false); setUncertain(false); } else if (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) setUncertain(true); else { confirmation.current = null; setReview(null); setConfirmed(false); } }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  const accepted = saved?.product.variants.find((row: Variant) => row.id === saved.variantId);
  return <form className="form-stack" onSubmit={update}>
    <p>Shopify · {account.name} · Account {account.id} · {store.name} · {store.domain} · Native product {product.id}</p><p className="helper-note">Change the price of one existing variant in {store.currency}. Saving can change the live storefront immediately.</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">Price editing requires a connected matching Shopify account and product read and price permissions.</p>}
    {closed && <p className="helper-note" role="status">{closed.notSent ? productNotSentMessage : <>The prior action is closed after operator review · {closed.id ?? 'Operation ID unavailable'} · {closed.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Your price is kept. Refresh current product prices and review a new action before saving again.</>}</p>}
    {writable && !saved && !uncertain && <button type="button" className="button" disabled={busy} onClick={() => loadProduct()}>Refresh current product prices</button>}
    {!ready && writable && <p role="status">{busy ? 'Loading current product prices…' : 'Load and verify the current product before choosing a variant.'}</p>}
    <fieldset disabled={busy || uncertain || !!saved || !writable || !ready}><p className="field-help">Only the provider’s first 100 variants are available here. This may be a partial list.</p><label className="field"><span>Product variant</span><select name="variantId" value={variantId} onChange={event => change('variantId', event.target.value)}><option value="">Choose a returned variant</option>{ready && snapshot.product.variants.map(row => <option key={row.id} value={row.id}>{row.title || row.id} · Native variant {row.id} · {row.price.amount} {row.price.currency}</option>)}</select></label>{variant && <p>Loaded price: {variant.price.amount} {variant.price.currency}</p>}{ready && !snapshot.product.variants.length && <p>No variants returned within provider coverage.</p>}<Field label={`New price in ${store.currency}`} name="price" type="text" inputMode="decimal" maxLength={100} value={price} onChange={event => change('price', event.target.value)}/><p className="field-help">Enter a decimal price using a period and up to two decimal places.</p><button type="button" className="button" onClick={prepare}>Review price change</button></fieldset>
    {review && review.revision === revision.current && (review.safety === safety || uncertain) && <section className="helper-note"><h3>Review Shopify variant price</h3><p>{account.name} · Account {account.id} · {review.store.name} · {review.store.domain} · Store URL {review.store.url ?? 'Not returned'} · Native product {review.product.id} · {review.product.title} · Native variant {review.variant.id} · {review.variant.title}</p><h4>Before</h4><p>{review.variant.price.amount} {review.variant.price.currency}</p><h4>After</h4><p>{review.price} {review.store.currency}</p><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={busy || uncertain || !writable} onChange={event => { if (!current() || !writable || view.pending || uncertain || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>I reviewed this exact account, store, native product and variant, and before/after price. I understand saving can change the live storefront immediately.</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable}>{busy ? 'Checking variant price…' : uncertain ? 'Check the same price change' : 'Save variant price'}</button></section>}
    {uncertain && <p className="alert" role="status">The outcome is unknown. Your price and original action are retained. Check the same price change before editing again; it is never retried automatically.</p>}
    {saved && <section className="helper-note" role="status"><p>Variant price confirmed by Shopify readback · Account {saved.accountId} · {saved.store.domain} · Native product {saved.product.id} · Native variant {saved.variantId}</p><p>Accepted price: {accepted.price.amount} {accepted.price.currency}</p></section>}
  </form>;
}

type ProductStateAction = ProductSnapshot & { action: 'deactivate' | 'archive' | 'activate' | 'delete'; safety: object; revision: number };
function productStateSnapshot(value: any, account: Account, store: Store, product: Product, resource: string, action: 'deactivate' | 'archive' | 'activate' | 'delete'): ProductSnapshot {
  const version = action === 'delete' ? value?.deleteVersion : action === 'archive' ? value?.archiveVersion : action === 'activate' ? value?.activateVersion : value?.version;
  if (!readableProduct(value?.product, account.id) || value.product.id !== product.id || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(store) || !productStateAllowed(account, value.store, value.product, action) || typeof version !== 'string' || !version) throw new Error('The exact product, store and status permissions could not be verified. Refresh the current product and review again.');
  return { resource, product: value.product, store: value.store, version };
}
function validateProductStateReceipt(value: any, account: Account, action: ProductStateAction) {
  const status = action.action === 'archive' ? 'archived' : action.action === 'activate' ? 'active' : 'draft';
  const deletion = value?.deletionAcceptance, validProduct = action.action === 'delete' ? !Object.hasOwn(value || {}, 'product') && deletion?.productId === action.product.id && deletion.platform === 'shopify' && deletion.action === 'delete' && deletion.absenceVerified === true && typeof deletion.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(deletion.checkedAt) && Number.isFinite(Date.parse(deletion.checkedAt)) : readableProduct(value?.product, account.id) && value.product.id === action.product.id && value.product.status === status && value.product.platformStatus === status.toUpperCase();
  if (value?.accountId !== account.id || !validProduct || !readableStore(value?.store, account.id) || storeIdentity(value.store) !== storeIdentity(action.store) || value.readback !== true || value.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id) throw new Error('The product state receipt could not be verified. Check the outcome of the same action before making another change.');
}

export function ProductStateReview({ account, store, product, request, readOnly = false, stateAction = 'deactivate' }: { account: Account; store: Store; product: Product; request: Request; readOnly?: boolean; stateAction?: 'deactivate' | 'archive' | 'activate' | 'delete' }) {
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null), [review, setReview] = useState<ProductStateAction | null>(null), [unknown, setUnknown] = useState<ProductStateAction | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<any>(null), [closed, setClosed] = useState<{ id?: string; status?: string; notSent?: boolean } | null>(null);
  const resource = JSON.stringify([account.id, account.platform, store.accountId, store.platform, store.domain, store.url, product.id, product.accountId, product.platform, stateAction]), writable = !readOnly && productStateAllowed(account, store, product, stateAction);
  const deleteProduct = stateAction === 'delete', archive = stateAction === 'archive', activate = stateAction === 'activate', actionLabel = deleteProduct ? 'Permanently delete product' : archive ? 'Archive product' : activate ? 'Activate product' : 'Move to draft', targetState = deleteProduct ? 'Permanently deleted (absence verified)' : archive ? 'Archived' : activate ? 'Active' : 'Draft';
  const identity = JSON.stringify([resource, account, storeIdentity(store), product, writable]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity, account, store, product]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<ProductStateAction | null>(null), recovery = useRef<ProductStateAction | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; revision.current++; confirmation.current = null; setSnapshot(null); setReview(null); setConfirmed(false); }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, ready = snapshot?.resource === resource, target = `products/${encodeURIComponent(account.id)}/${encodeURIComponent(product.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { recovery.current = null; setSnapshot(null); setReview(null); setUnknown(null); setConfirmed(false); setBusy(false); setError(''); setSaved(null); setClosed(null); if (writable) void loadProduct(true); }, [resource]);
  async function loadProduct(initial = false) {
    if (!current() || !writable || view.pending || !initial && (unknown || saved)) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setSnapshot(null); setReview(null); setConfirmed(false); setError('');
    try {
      const fresh = productStateSnapshot(await requester.current(target), account, store, product, resource, stateAction);
      if (!current() || read !== revision.current) return;
      setSnapshot(fresh);
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || unknown || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const fresh = productStateSnapshot(await requester.current(target), account, store, product, resource, stateAction);
      if (!current() || read !== revision.current) return;
      if (fresh.version !== snapshot.version) { setSnapshot(null); throw new Error('This product changed on Shopify. Refresh the current product and review again.'); }
      setReview({ ...fresh, action: stateAction, safety, revision: read });
    } catch (failure) { if (current() && read === revision.current) setError(failureMessage(failure)); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function deactivate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = unknown || review;
    if (!current() || !writable || view.pending || saved || !action || action.resource !== resource || action.action !== stateAction || storeIdentity(action.store) !== storeIdentity(store) || (unknown ? recovery.current !== action : !ready || action.safety !== safety || action.revision !== revision.current || confirmation.current !== action || !confirmed)) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: action.version, ...(action.action === 'delete' ? { confirmDelete: true } : action.action === 'archive' ? { confirmArchive: true } : action.action === 'activate' ? { confirmActivate: true } : { confirmDeactivate: true }) }, validate = (value: any) => validateProductStateReceipt(value, account, action);
      const result = await requester.current(target + '/' + action.action, body, validate, !!unknown); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; recovery.current = null; setSaved(result); setReview(null); setUnknown(null); setConfirmed(false);
    } catch (failure) {
      if (sameDestination()) {
        const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } };
        setError(problem.message || 'The product state change could not be confirmed.'); confirmation.current = null; setReview(null); setConfirmed(false);
        if (productRequestNotSent(problem)) { revision.current++; recovery.current = null; setClosed({ notSent: true }); setSnapshot(null); setUnknown(null); } else if (problem.code === 'OPERATION_REVIEWED') { revision.current++; recovery.current = null; setClosed(problem.operation || {}); setSnapshot(null); setUnknown(null); }
        else if (unknown || !problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) { recovery.current = action; setUnknown(action); }
      }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={deactivate}>
    <p>Shopify · {account.name} · Account {account.id} · {store.name} · {store.domain} · Native product {product.id}</p><p className="helper-note">{deleteProduct ? 'Permanently delete this Archived product. This cannot be undone. Shopify removes the product, its variants and inventory items, sales-channel publications, and media not used by other products.' : archive ? 'Archive this Active or Draft product. Archiving makes it unavailable to customers on sales channels and apps; it does not delete the product. This control does not restore products or manage channel publication.' : activate ? 'Activate this Draft product. Activation changes its product status and may affect customer availability. Channel publication is separately unverified.' : 'Move this product from Active to Draft.'}</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">{deleteProduct ? 'Permanent deletion requires a connected matching Shopify account, product read and status permissions, and an exact Archived/ARCHIVED product.' : archive ? 'Archiving requires a connected matching Shopify account, product read and status permissions, and an exact Active/ACTIVE or Draft/DRAFT product.' : activate ? 'Activation requires a connected matching Shopify account, product read and status permissions, and an exact Draft/DRAFT product.' : 'Moving to draft requires a connected matching Shopify account, product read and status permissions, and an Active product with native status ACTIVE.'}</p>}
    {closed && <p className="helper-note" role="status">{closed.notSent ? productNotSentMessage : <>The prior action is closed after operator review · {closed.id ?? 'Operation ID unavailable'} · {closed.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Refresh the current product and explicitly review a new action before {deleteProduct ? 'permanently deleting' : archive ? 'archiving' : activate ? 'activating' : 'moving to draft'} again.</>}</p>}
    {writable && !saved && !unknown && <button type="button" className="button" disabled={busy} onClick={() => loadProduct()}>Refresh current product state</button>}
    {!ready && writable && !unknown && !saved && <p role="status">{busy ? 'Loading current product state…' : 'Load and verify the current product before reviewing.'}</p>}
    <fieldset disabled={busy || !!unknown || !!saved || !writable || !ready}><button type="button" className="button" onClick={prepare}>{deleteProduct ? 'Review permanent deletion' : archive ? 'Review archive' : activate ? 'Review activation' : 'Review move to draft'}</button></fieldset>
    {review && review.revision === revision.current && review.safety === safety && <section className="helper-note"><h3>Review Shopify product state</h3><p>{account.name} · Account {account.id} · {review.store.name} · {review.store.domain} · Store URL {review.store.url ?? 'Not returned'} · Native product {review.product.id} · {review.product.title}</p><p>Before: {review.product.status === 'archived' ? 'Archived' : review.product.status === 'active' ? 'Active' : 'Draft'} · {review.product.status} · {review.product.platformStatus}</p><p>After: {deleteProduct ? targetState : <>{targetState} · {targetState.toLowerCase()} · {targetState.toUpperCase()}</>}</p><label className="checkbox-label"><input type="checkbox" name={deleteProduct ? 'confirmDelete' : archive ? 'confirmArchive' : activate ? 'confirmActivate' : 'confirmDeactivate'} checked={confirmed} disabled={busy || !writable} onChange={event => { if (!current() || !writable || view.pending || unknown || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>I reviewed this exact account, store and native product. {deleteProduct ? 'I understand that this permanently deletes this exact Archived product and cannot be undone.' : archive ? 'I understand that this archives the product and makes it unavailable to customers.' : activate ? 'I understand that this changes the product from Draft to Active and may affect customer availability. Channel publication remains unverified.' : 'I understand that this changes its product status from Active to Draft.'}</label><button type="submit" className={deleteProduct ? "button danger" : "button primary"} disabled={busy || !confirmed || !writable}>{actionLabel}</button></section>}
    {unknown && <Alert title="Outcome unknown" tone="warning" role="status"><div className="t98-settings-fields"><p>The outcome is unknown. The original product and action are retained. Check outcome uses the same action; it is never retried automatically.</p><p>Account {account.id} · {unknown.store.domain} · Native product {unknown.product.id} · {unknown.product.title} · {unknown.product.status} → {targetState}</p><button type="submit" className="button" disabled={busy || !writable || storeIdentity(unknown.store) !== storeIdentity(store)}>{busy ? 'Checking outcome…' : 'Check outcome'}</button></div></Alert>}
    {saved && deleteProduct && <section className="helper-note" role="status"><p>Product deletion confirmed by Shopify absence readback · Account {saved.accountId} · {saved.store.domain} · Native product {saved.deletionAcceptance.productId} · Checked {saved.deletionAcceptance.checkedAt} · Permanently deleted</p></section>}{saved && !deleteProduct && <section className="helper-note" role="status"><p>Product state confirmed by Shopify readback · Account {saved.accountId} · {saved.store.domain} · Native product {saved.product.id} · {saved.product.title} · {saved.product.status} · {saved.product.platformStatus}</p></section>}
  </form>;
}
