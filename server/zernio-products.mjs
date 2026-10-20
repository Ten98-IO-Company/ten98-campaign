import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount } from './integrations.mjs';
import { validPostInstant } from '../shared/social-posts.ts';
import { transaction } from './database.mjs';

const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const nullableText = (value, max) => value == null || text(value, max);
const sameTags = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const identifier = value => text(value, 500) && !!value && !['.', '..'].includes(value) && !/[\s/?#]/.test(value);
const statuses = ['active', 'draft', 'pending_review', 'rejected', 'inactive', 'archived', 'deleted'];
const coverage = { imagesLimit: 20, variantsLimit: 100 };
const stockCoverage = { ...coverage, inventoryComplete: null, locationsComplete: null, localLocationsLimit: 1000, localInventoryItemsLimit: 10000, localInventoryLevelsLimit: 10000 };
const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable store products.');
const identity = account => JSON.stringify([account._id, account.platform, String(account.profileId?._id || account.profileId), account.platformUserId ?? null, account.username ?? null, account.displayName ?? null, account.isActive ?? null, account.needsReconnection ?? null]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decimal = value => value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
function providerReadError(error, stock = false) {
  if (error instanceof IntegrationError && error.providerStatus === 403) fail(403, stock ? 'INVENTORY_READ_PERMISSION_REQUIRED' : 'PRODUCT_READ_PERMISSION_REQUIRED', stock ? 'This store’s stock could not be read. Check its connection and inventory reading permissions.' : 'This store could not be read. Check its connection and product reading permissions.');
  throw error;
}

function access(context, profileId) {
  try { context.assertProjectMapping?.(profileId); context.assertIntegrationSettings?.(); }
  catch (error) { fail(error.status === 403 ? 403 : 409, error.status === 403 ? 'PROJECT_ACCESS_CHANGED' : 'PROJECT_CONNECTION_CHANGED', 'Your project access or connection changed. Refresh before continuing.'); }
}
function accountRow(account) {
  if (!identifier(account._id) || account.platform !== 'shopify' || account.needsReconnection != null && typeof account.needsReconnection !== 'boolean' || ['platformUserId', 'username', 'displayName'].some(key => !nullableText(account[key], 2000))) invalid();
  return { id: account._id, platform: 'shopify', name: account.displayName || account.username || 'Shopify', isActive: account.isActive !== false, needsReconnection: account.needsReconnection === true };
}
async function accounts(context, api, profileId) {
  access(context, profileId);
  const rows = await scopedAccounts(api, profileId).catch(providerReadError);
  access(context, profileId);
  if (rows.length > 10000 || new Set(rows.map(row => row._id)).size !== rows.length) invalid();
  return rows.filter(row => row.platform === 'shopify').map(row => { accountRow(row); return row; });
}
async function selected(context, api, profileId, accountId) {
  const account = requireAccount(await accounts(context, api, profileId), accountId);
  if (account.isActive === false || account.needsReconnection === true) fail(409, 'PRODUCT_ACCOUNT_UNAVAILABLE', 'Reconnect this store before reading products.');
  return account;
}
function scope(value, account, profileId) {
  if (!object(value) || value.platform !== undefined && value.platform !== 'shopify' || value.accountId !== undefined && value.accountId !== account._id || value.profileId !== undefined && String(value.profileId?._id || value.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned store products outside this project or account.');
}
async function read(context, api, profileId, account, path, query, stock = false) {
  access(context, profileId);
  const response = await api(path, query).catch(error => providerReadError(error, stock));
  access(context, profileId);
  const fresh = await selected(context, api, profileId, account._id);
  if (identity(fresh) !== identity(account)) fail(409, 'PRODUCT_ACCOUNT_CHANGED', 'The connected store changed. Load its products again.');
  scope(response, account, profileId);
  return response;
}
function storeRow(value, account, profileId) {
  scope(value, account, profileId);
  if (value.accountId !== account._id || value.platform !== 'shopify' || !text(value.name, 10000) || !text(value.domain, 500) || !value.domain || value.url !== null && !text(value.url, 4000) || !/^[A-Z]{3}$/.test(value.currency || '') || value.country !== null && !/^[A-Z]{2}$/.test(value.country || '') || value.grantPermissionsUrl !== null && !text(value.grantPermissionsUrl, 4000)) invalid();
  for (const key of ['capabilities', 'missingCapabilities']) if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(item => !text(item, 100) || !item) || new Set(value[key]).size !== value[key].length) invalid();
  if (value.capabilities.some(item => value.missingCapabilities.includes(item))) invalid();
  return { accountId: value.accountId, platform: value.platform, name: value.name, domain: value.domain, url: value.url ?? null, currency: value.currency, country: value.country, capabilities: value.capabilities, missingCapabilities: value.missingCapabilities, grantPermissionsUrl: value.grantPermissionsUrl ?? null };
}
async function storeRead(context, api, profileId, account) {
  const response = await read(context, api, profileId, account, '/commerce/store', { accountId: account._id });
  return storeRow(response.store, account, profileId);
}
function permission(store, write) {
  for (const capability of write ? ['products.read', `products.${write}`] : ['products.read']) if (!store.capabilities.includes(capability) || store.missingCapabilities.includes(capability)) fail(403, capability === 'products.read' ? 'PRODUCT_READ_PERMISSION_REQUIRED' : write === 'create' ? 'PRODUCT_CREATE_PERMISSION_REQUIRED' : write === 'price' ? 'PRODUCT_PRICE_PERMISSION_REQUIRED' : write === 'status' ? 'PRODUCT_STATUS_PERMISSION_REQUIRED' : 'PRODUCT_UPDATE_PERMISSION_REQUIRED', 'This store has not granted the required product permissions. Ask a workspace administrator to reconnect it or review its permissions.');
}
function claimProduct(context, account, productId, key) {
  const nativeProductId = /^\d{1,500}$/.test(productId) ? String(BigInt(productId)) : productId;
  const resource = JSON.stringify(['shopify', account.platformUserId, nativeProductId]), { db } = context;
  const previous = db.prepare('SELECT o.status FROM zernio_product_updates p LEFT JOIN integration_operations o ON o.project_id=p.project_id AND o.request_key=p.request_key WHERE p.resource=?').get(resource);
  if (previous && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED', 'This change was not sent. Review the earlier product outcome before changing this product again.');
  db.prepare('INSERT INTO zernio_product_updates VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
}
function editable(product) {
  if (product.status === 'deleted') fail(409, 'PRODUCT_DELETED', 'A deleted product cannot be updated. Load and review another product.');
}
function productRow(value, account, profileId, currency, expectedId) {
  scope(value, account, profileId);
  if (!Object.hasOwn(value, 'accountId') || value.accountId !== account._id || value.platform !== 'shopify' || !identifier(value.id) || expectedId !== undefined && value.id !== expectedId || !text(value.title, 10000) || !statuses.includes(value.status) || !text(value.platformStatus, 2000)) invalid();
  for (const key of ['descriptionHtml', 'handle', 'vendor', 'productType', 'url']) if (!nullableText(value[key], key === 'descriptionHtml' ? 1000000 : 10000)) invalid();
  for (const key of ['createdAt', 'updatedAt', 'publishedAt']) if (value[key] != null && !validPostInstant(value[key])) invalid();
  if (value.totalInventory != null && !Number.isSafeInteger(value.totalInventory)) invalid();
  function strings(rows, max, length) { if (!Array.isArray(rows) || rows.length > max || rows.some(item => !text(item, length))) invalid(); return rows; }
  function money(row) {
    scope(row, account, profileId);
    if (!text(row.amount, 100) || !/^\d+(?:\.\d+)?$/.test(row.amount) || row.currency !== currency) invalid();
    return { amount: row.amount, currency: row.currency };
  }
  function image(row) {
    scope(row, account, profileId);
    if (!nullableText(row.id, 500) || !text(row.url, 4000) || !row.url || !nullableText(row.altText, 10000)) invalid();
    return { id: row.id ?? null, url: row.url, altText: row.altText ?? null };
  }
  function pairs(rows) {
    if (!Array.isArray(rows) || rows.length > 100) invalid();
    return rows.map(row => { scope(row, account, profileId); if (!text(row.name, 2000) || !text(row.value, 2000)) invalid(); return { name: row.name, value: row.value }; });
  }
  if (!Array.isArray(value.images) || value.images.length > coverage.imagesLimit || !Array.isArray(value.variants) || value.variants.length > coverage.variantsLimit || !Array.isArray(value.options) || value.options.length > 100) invalid();
  const variants = value.variants.map(row => {
    scope(row, account, profileId);
    if (!identifier(row.id) || !text(row.title, 10000) || !nullableText(row.sku, 2000) || !nullableText(row.barcode, 2000) || row.inventoryQuantity != null && !Number.isSafeInteger(row.inventoryQuantity) || row.availableForSale != null && typeof row.availableForSale !== 'boolean') invalid();
    return { id: row.id, title: row.title, sku: row.sku ?? null, barcode: row.barcode ?? null, price: money(row.price), compareAtPrice: row.compareAtPrice == null ? null : money(row.compareAtPrice), inventoryQuantity: row.inventoryQuantity ?? null, availableForSale: row.availableForSale ?? null, options: pairs(row.options) };
  });
  if (new Set(variants.map(row => row.id)).size !== variants.length) invalid();
  const options = value.options.map(row => { scope(row, account, profileId); if (!text(row.name, 2000)) invalid(); return { name: row.name, values: strings(row.values, 1000, 2000) }; });
  if (value.seo != null) { scope(value.seo, account, profileId); if (!nullableText(value.seo.title, 10000) || !nullableText(value.seo.description, 100000)) invalid(); }
  return { id: value.id, accountId: value.accountId, platform: value.platform, title: value.title, descriptionHtml: value.descriptionHtml ?? null, handle: value.handle ?? null, vendor: value.vendor ?? null, productType: value.productType ?? null, tags: strings(value.tags, 1000, 2000), status: value.status, platformStatus: value.platformStatus, featuredImage: value.featuredImage == null ? null : image(value.featuredImage), images: value.images.map(image), options, variants, totalInventory: value.totalInventory ?? null, url: value.url ?? null, seo: { title: value.seo?.title ?? null, description: value.seo?.description ?? null }, createdAt: value.createdAt ?? null, updatedAt: value.updatedAt ?? null, publishedAt: value.publishedAt ?? null };
}
function page(url) {
  for (const key of url.searchParams.keys()) if (!['limit', 'cursor', 'status', 'query', 'collectionId'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'INVALID_PRODUCT_QUERY', 'Use only the product page, collection, search and status controls.');
  const limit = url.searchParams.get('limit') ?? '20', cursor = url.searchParams.get('cursor'), status = url.searchParams.get('status'), query = url.searchParams.get('query'), collection = url.searchParams.get('collectionId');
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit) || cursor !== null && (!text(cursor, 4096) || !cursor) || status !== null && !statuses.includes(status) || query !== null && (!text(query, 500) || /[\r\n\t]/.test(query)) || collection !== null && !collectionId(collection)) fail(400, 'INVALID_PRODUCT_QUERY', 'Use a page size from 1 to 100, an unchanged provider cursor, a returned collection and a supported product status.');
  return { limit: Number(limit), ...(cursor === null ? {} : { cursor }), ...(status === null ? {} : { status }), ...(query === null ? {} : { query }), ...(collection === null ? {} : { collectionId: collection }) };
}
async function snapshot(context, api, profileId, accountId, productId, expectedState) {
  const account = await selected(context, api, profileId, accountId), store = await storeRead(context, api, profileId, account);
  permission(store);
  const result = await read(context, api, profileId, account, `/commerce/products/${encodeURIComponent(productId)}`, { accountId });
  if (expectedState && (result.product?.status !== expectedState || result.product?.platformStatus !== expectedState.toUpperCase())) fail(409, 'PRODUCT_STATE_CHANGED', `The product must currently be ${expectedState}. Load and review its current details again.`);
  const product = productRow(result.product, account, profileId, store.currency, productId), after = await storeRead(context, api, profileId, account);
  permission(after);
  if (JSON.stringify(after) !== JSON.stringify(store)) fail(409, 'PRODUCT_STORE_CHANGED', 'The store details or permissions changed. Load its products again.');
  access(context, profileId);
  return { account, product, store, version: hash([profileId, identity(account), store, product]) };
}
async function creationSnapshot(context, api, profileId, accountId) {
  const account = await selected(context, api, profileId, accountId), store = await storeRead(context, api, profileId, account), after = await storeRead(context, api, profileId, account);
  if (JSON.stringify(after) !== JSON.stringify(store)) fail(409, 'PRODUCT_STORE_CHANGED', 'The store details or permissions changed. Load its products again.');
  access(context, profileId);
  return { account, store, version: hash([profileId, identity(account), store]) };
}
function createdDraft(product, title, price) {
  if (product.status !== 'draft' || product.platformStatus !== 'DRAFT' || product.url !== null || product.publishedAt !== null || product.title !== title || product.variants.length !== 1 || decimal(product.variants[0].price.amount) !== decimal(price)) fail(502, 'PRODUCT_DRAFT_NOT_CONFIRMED', 'The provider did not confirm the exact unpublished draft and reviewed price.');
}

function stockPermission(store) {
  permission(store);
  if (!store.capabilities.includes('inventory.read') || store.missingCapabilities.includes('inventory.read')) fail(403, 'INVENTORY_READ_PERMISSION_REQUIRED', 'This store has not granted inventory reading permission. Ask a workspace administrator to review its permissions.');
}
function stockRows(locationResponse, inventoryResponse, account, profileId, productId) {
  const invalidStock = () => fail(502, 'INVALID_INVENTORY_RESPONSE', 'Zernio returned unreadable stock or locations.');
  if (!Array.isArray(locationResponse.locations) || locationResponse.locations.length > stockCoverage.localLocationsLimit || !Array.isArray(inventoryResponse.inventory) || inventoryResponse.inventory.length > stockCoverage.localInventoryItemsLimit) invalidStock();
  const addressKeys = ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode', 'phone'];
  const locations = locationResponse.locations.map(row => {
    scope(row, account, profileId);
    if (!identifier(row.id) || !nullableText(row.name, 10000) || ['isActive', 'fulfillsOnlineOrders'].some(key => row[key] != null && typeof row[key] !== 'boolean')) invalidStock();
    let address = null;
    if (row.address != null) {
      scope(row.address, account, profileId);
      if (addressKeys.some(key => !nullableText(row.address[key], 10000))) invalidStock();
      address = Object.fromEntries(addressKeys.map(key => [key, row.address[key] ?? null]));
    }
    return { id: row.id, name: row.name ?? null, isActive: row.isActive ?? null, fulfillsOnlineOrders: row.fulfillsOnlineOrders ?? null, address };
  });
  if (new Set(locations.map(row => row.id)).size !== locations.length) invalidStock();
  let levelCount = 0;
  const inventory = inventoryResponse.inventory.map(row => {
    scope(row, account, profileId);
    if (!identifier(row.productId) || row.productId !== productId || !identifier(row.variantId) || !nullableText(row.sku, 2000) || row.tracked != null && typeof row.tracked !== 'boolean' || row.levels != null && !Array.isArray(row.levels)) invalidStock();
    let levels = null;
    if (row.levels != null) {
      levelCount += row.levels.length;
      if (levelCount > stockCoverage.localInventoryLevelsLimit) invalidStock();
      levels = row.levels.map(level => {
        scope(level, account, profileId);
        const quantities = ['available', 'onHand', 'committed', 'incoming'];
        if (!identifier(level.locationId) || quantities.some(key => level[key] != null && !Number.isSafeInteger(level[key]))) invalidStock();
        return { locationId: level.locationId, ...Object.fromEntries(quantities.map(key => [key, level[key] ?? null])) };
      });
      if (new Set(levels.map(level => level.locationId)).size !== levels.length) invalidStock();
    }
    return { productId: row.productId, variantId: row.variantId, sku: row.sku ?? null, tracked: row.tracked ?? null, levels };
  });
  if (new Set(inventory.map(row => row.variantId)).size !== inventory.length) invalidStock();
  return { locations, inventory };
}

const collectionId = value => text(value, 500) && !!value && !/\s/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
const invalidCollection = () => fail(502, 'INVALID_COLLECTION_RESPONSE', 'Zernio returned unreadable store collections.');
function collectionPermission(store, write = false) {
  for (const capability of write ? ['collections.read', 'collections.write'] : ['collections.read']) if (!store.capabilities.includes(capability) || store.missingCapabilities.includes(capability)) fail(403, capability === 'collections.read' ? 'COLLECTION_READ_PERMISSION_REQUIRED' : 'COLLECTION_WRITE_PERMISSION_REQUIRED', 'This store has not granted the required collection permissions. Ask a workspace administrator to review its permissions.');
}
function collectionRow(value, account, profileId, expectedId) {
  scope(value, account, profileId);
  if (value.accountId !== account._id || value.platform !== 'shopify' || !collectionId(value.id) || expectedId !== undefined && value.id !== expectedId || !text(value.title, 10000)) invalidCollection();
  if (!nullableText(value.handle, 10000) || !nullableText(value.descriptionHtml, 1000000) || value.productCount != null && !Number.isSafeInteger(value.productCount) || value.updatedAt != null && !validPostInstant(value.updatedAt) || value.sortOrder !== undefined && !['manual', 'best_selling', 'alpha_asc', 'alpha_desc', 'price_asc', 'price_desc', 'created', 'created_desc', 'most_relevant'].includes(value.sortOrder)) invalidCollection();
  let image = null;
  if (value.image != null) {
    scope(value.image, account, profileId);
    if (!nullableText(value.image.id, 500) || !text(value.image.url, 4000) || !value.image.url || !nullableText(value.image.altText, 10000)) invalidCollection();
    image = { id: value.image.id ?? null, url: value.image.url, altText: value.image.altText ?? null };
  }
  if (value.seo !== undefined) {
    scope(value.seo, account, profileId);
    if (!nullableText(value.seo.title, 10000) || !nullableText(value.seo.description, 100000)) invalidCollection();
  }
  return { id: value.id, accountId: value.accountId, platform: value.platform, title: value.title, handle: value.handle ?? null, descriptionHtml: value.descriptionHtml ?? null, image, sortOrder: value.sortOrder ?? null, productCount: value.productCount ?? null, seo: { title: value.seo?.title ?? null, description: value.seo?.description ?? null }, updatedAt: value.updatedAt ?? null };
}
async function collectionRead(context, api, profileId, account, id) {
  try {
    const result = await read(context, api, profileId, account, '/commerce/collections/' + encodeURIComponent(id), { accountId: account._id });
    return collectionRow(result.collection, account, profileId, id);
  } catch (error) {
    if (error instanceof IntegrationError && error.code === 'PRODUCT_READ_PERMISSION_REQUIRED') fail(403, 'COLLECTION_READ_PERMISSION_REQUIRED', 'This store’s collections could not be read. Check its connection and collection reading permissions.');
    if (error instanceof IntegrationError && error.providerStatus === 404) fail(404, 'COLLECTION_NOT_FOUND', 'This collection or connected store could not be found. Refresh before continuing.');
    throw error;
  }
}
async function collectionSnapshot(context, api, profileId, accountId, id) {
  const account = await selected(context, api, profileId, accountId), store = await storeRead(context, api, profileId, account);
  collectionPermission(store, true);
  const collection = await collectionRead(context, api, profileId, account, id), after = await storeRead(context, api, profileId, account);
  collectionPermission(after, true);
  if (JSON.stringify(after) !== JSON.stringify(store)) fail(409, 'COLLECTION_STORE_CHANGED', 'The store details or permissions changed. Load and review the collection again.');
  access(context, profileId);
  return { account, store, collection, version: hash([profileId, identity(account), store, collection]) };
}
function claimCollection(context, account, id, key) {
  const numeric = id.match(/^(?:gid:\/\/shopify\/Collection\/)?(\d+)$/)?.[1];
  const resource = JSON.stringify(['shopify', account.platformUserId, numeric ? String(BigInt(numeric)) : id]), { db } = context;
  // Claim and inspect atomically across connections, aliases and projects; pending outcomes survive process restarts.
  transaction(db, () => {
    const previous = db.prepare('SELECT o.status FROM zernio_collection_updates c LEFT JOIN integration_operations o ON o.project_id=c.project_id AND o.request_key=c.request_key WHERE c.resource=?').get(resource);
    if (previous && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED', 'This rename was not sent. Review the earlier collection outcome before renaming this collection again.');
    db.prepare('INSERT INTO zernio_collection_updates VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
  });
}
function collectionPage(url) {
  for (const key of url.searchParams.keys()) if (!['limit', 'cursor', 'query'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'INVALID_COLLECTION_QUERY', 'Use only the collection page and search controls.');
  const limit = url.searchParams.get('limit') ?? '20', cursor = url.searchParams.get('cursor'), query = url.searchParams.get('query');
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit) || cursor !== null && (!text(cursor, 4096) || !cursor) || query !== null && (!text(query, 500) || /[\r\n\t]/.test(query))) fail(400, 'INVALID_COLLECTION_QUERY', 'Use a page size from 1 to 100 and an unchanged provider cursor.');
  return { limit: Number(limit), ...(cursor === null ? {} : { cursor }), ...(query === null ? {} : { query }) };
}

export async function handleZernioProducts(context, api, profileId, action) {
  const { req, url, send, body = {}, role, db } = context;
  const parts = action.split('/');
  if (parts[1] === 'collections' && parts.length === 4 && ['edit', 'rename'].includes(parts[3])) {
    const rename = parts[3] === 'rename';
    if (req.method !== (rename ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the reviewed collection rename controls.');
    if (rename && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required to rename a collection.');
    let accountId, id;
    try { accountId = decodeURIComponent(parts[0]); id = decodeURIComponent(parts[2]); } catch { fail(400, 'INVALID_COLLECTION_ID', 'Choose a connected store and returned collection.'); }
    if (!identifier(accountId) || !collectionId(id)) fail(400, 'INVALID_COLLECTION_ID', 'Choose a connected store and returned collection.');
    if (url.search && !(rename && url.searchParams.size === 1 && url.searchParams.get('check') === '1')) fail(400, 'INVALID_COLLECTION_QUERY', 'A reviewed collection rename does not accept filters.');
    if (!rename) {
      if (!object(body) || Object.keys(body).length || Number(req.headers?.['content-length'] || 0) > 0 || req.headers?.['transfer-encoding']) fail(400, 'INVALID_COLLECTION_QUERY', 'Review the collection without a request body.');
      const { store, collection, version } = await collectionSnapshot(context, api, profileId, accountId, id);
      access(context, profileId); send(200, { accountId, store, collection, version }); return true;
    }
    if (!object(body) || Object.keys(body).some(key => !['version', 'title'].includes(key)) || !/^[a-f0-9]{64}$/.test(body.version || '') || !text(body.title, 10000) || !body.title.trim() || /[\r\n\t]/.test(body.title)) fail(400, 'COLLECTION_REVIEW_REQUIRED', 'Review the current collection and enter a nonblank, single line title.');
    access(context, profileId);
    db.exec('CREATE TABLE IF NOT EXISTS zernio_collection_updates(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await collectionSnapshot(context, api, profileId, accountId, id), title = body.title.trim();
      if (before.version !== body.version) fail(409, 'COLLECTION_CHANGED', 'The connected store or collection changed. Load and review its current title again.');
      if (title === before.collection.title) fail(400, 'EMPTY_COLLECTION_RENAME', 'Enter a title that changes the current collection title.');
      if (!text(before.account.platformUserId, 2000) || !before.account.platformUserId.trim() || before.account.platformUserId !== before.account.platformUserId.trim()) fail(409, 'COLLECTION_STORE_IDENTITY_UNAVAILABLE', 'The native store identity could not be verified. Refresh or reconnect this account before renaming a collection.');
      const ready = await collectionSnapshot(context, api, profileId, accountId, id);
      if (ready.version !== before.version) fail(409, 'COLLECTION_CHANGED', 'The collection changed before its rename could be sent. Load and review it again.');
      access(context, profileId); claimCollection(context, ready.account, id, key);
      // Zernio has no conditional collection PATCH: an external edit after the final read can race this rename.
      const response = await api('/commerce/collections/' + encodeURIComponent(id), {}, { accountId, title }, key, 'PATCH');
      try {
        access(context, profileId); scope(response, before.account, profileId);
        const receipt = collectionRow(response.collection, before.account, profileId, id);
        if (receipt.title !== title) fail(502, 'COLLECTION_RENAME_NOT_CONFIRMED', 'The provider did not confirm the requested collection title.');
        const after = await collectionSnapshot(context, api, profileId, accountId, id);
        if (identity(after.account) !== identity(before.account) || JSON.stringify(after.store) !== JSON.stringify(before.store) || after.collection.title !== title) fail(502, 'COLLECTION_RENAME_NOT_CONFIRMED', 'The collection title, store identity or permissions changed before confirmation.');
        access(context, profileId);
        return { accountId, collection: after.collection, store: after.store, version: after.version, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-collection-update:${accountId}:${id}`);
    access(context, profileId); send(outcome.status, outcome.data); return true;
  }
  if (parts[1] === 'collections' && [2, 3].includes(parts.length)) {
    if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Use the collection reading controls.');
    if (!object(body) || Object.keys(body).length || Number(req.headers?.['content-length'] || 0) > 0 || req.headers?.['transfer-encoding']) fail(400, 'INVALID_COLLECTION_QUERY', 'Load collections without a request body.');
    let accountId, id;
    try { accountId = decodeURIComponent(parts[0]); id = parts.length === 3 ? decodeURIComponent(parts[2]) : undefined; } catch { fail(400, 'INVALID_COLLECTION_ID', 'Choose a connected store and returned collection.'); }
    if (!identifier(accountId) || id !== undefined && !collectionId(id)) fail(400, 'INVALID_COLLECTION_ID', 'Choose a connected store and returned collection.');
    if (id !== undefined && url.search) fail(400, 'INVALID_COLLECTION_QUERY', 'A collection detail does not accept filters.');
    const query = id === undefined ? collectionPage(url) : {};
    try {
      const account = await selected(context, api, profileId, accountId), store = await storeRead(context, api, profileId, account);
      collectionPermission(store);
      const result = await read(context, api, profileId, account, `/commerce/collections${id === undefined ? '' : '/' + encodeURIComponent(id)}`, { accountId, ...query });
      let response;
      if (id === undefined) {
        if (!Array.isArray(result.collections) || result.collections.length > query.limit || result.nextCursor !== null && (!text(result.nextCursor, 4096) || !result.nextCursor || result.nextCursor === query.cursor)) invalidCollection();
        const collections = result.collections.map(row => collectionRow(row, account, profileId));
        if (new Set(collections.map(row => row.id)).size !== collections.length) invalidCollection();
        response = { collections, nextCursor: result.nextCursor };
      } else response = { collection: collectionRow(result.collection, account, profileId, id) };
      const after = await storeRead(context, api, profileId, account);
      collectionPermission(after);
      if (JSON.stringify(after) !== JSON.stringify(store)) fail(409, 'COLLECTION_STORE_CHANGED', 'The store details or permissions changed. Load its collections again.');
      access(context, profileId); send(200, { accountId, store: after, ...response }); return true;
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'PRODUCT_READ_PERMISSION_REQUIRED') fail(403, 'COLLECTION_READ_PERMISSION_REQUIRED', 'This store’s collections could not be read. Check its connection and collection reading permissions.');
      if (error instanceof IntegrationError && error.providerStatus === 404) fail(404, 'COLLECTION_NOT_FOUND', 'This collection or connected store could not be found. Refresh before continuing.');
      throw error;
    }
  }
  if (parts.some(part => !part) || parts.length > 3 || parts.length === 3 && !['update', 'price', 'deactivate', 'archive', 'activate', 'delete', 'inventory'].includes(parts[2])) return false;
  const update = parts.length === 3 && parts[2] === 'update', price = parts.length === 3 && parts[2] === 'price', deactivate = parts.length === 3 && parts[2] === 'deactivate', archive = parts.length === 3 && parts[2] === 'archive', activate = parts.length === 3 && parts[2] === 'activate', deleteProduct = parts.length === 3 && parts[2] === 'delete', create = parts.length === 2 && parts[1] === 'create';
  if (req.method !== (update || price || deactivate || archive || activate || deleteProduct || create ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the reviewed product controls to create or update a product.');
  if ((update || price || deactivate || archive || activate || deleteProduct || create) && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required to create or update a product.');
  if (action === 'accounts') {
    if (url.search) fail(400, 'INVALID_PRODUCT_QUERY', 'The connected stores do not accept filters.');
    const result = (await accounts(context, api, profileId)).map(accountRow);
    access(context, profileId); send(200, { accounts: result }); return true;
  }
  let accountId, productId;
  try { accountId = decodeURIComponent(parts[0]); productId = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]); } catch { fail(400, 'INVALID_PRODUCT_ID', 'Choose a connected store and returned product.'); }
  if (!identifier(accountId) || productId !== undefined && !identifier(productId)) fail(400, 'INVALID_PRODUCT_ID', 'Choose a connected store and returned product.');
  if (parts.length >= 2 && url.search && !((update || price || deactivate || archive || activate || deleteProduct || create) && url.searchParams.size === 1 && url.searchParams.get('check') === '1')) fail(400, 'INVALID_PRODUCT_QUERY', 'This product action does not accept filters.');
  if (parts.length === 3 && parts[2] === 'inventory') {
    if (!object(body) || Object.keys(body).length || Number(req.headers?.['content-length'] || 0) > 0 || req.headers?.['transfer-encoding']) fail(400, 'INVALID_INVENTORY_QUERY', 'Load stock without a request body or filters.');
    const before = await snapshot(context, api, profileId, accountId, productId);
    stockPermission(before.store);
    const locationResponse = await read(context, api, profileId, before.account, '/commerce/locations', { accountId }, true);
    const ready = await storeRead(context, api, profileId, before.account);
    stockPermission(ready);
    if (JSON.stringify(ready) !== JSON.stringify(before.store)) fail(409, 'PRODUCT_STORE_CHANGED', 'The store details or permissions changed. Load its stock again.');
    const inventoryResponse = await read(context, api, profileId, before.account, '/commerce/inventory', { accountId, productId }, true);
    const after = await storeRead(context, api, profileId, before.account);
    stockPermission(after);
    if (JSON.stringify(after) !== JSON.stringify(before.store)) fail(409, 'PRODUCT_STORE_CHANGED', 'The store details or permissions changed. Load its stock again.');
    const rows = stockRows(locationResponse, inventoryResponse, before.account, profileId, productId);
    access(context, profileId); send(200, { accountId, product: before.product, store: after, ...rows, coverage: stockCoverage }); return true;
  }
  if (create) {
    if (!object(body) || Object.keys(body).some(key => !['version', 'confirmCreate', 'title', 'descriptionHtml', 'price'].includes(key)) || body.confirmCreate !== true || !/^[a-f0-9]{64}$/.test(body.version || '') || !text(body.title, 10000) || !body.title.trim() || /[\r\n\t]/.test(body.title) || !text(body.price, 100) || body.price !== body.price.trim() || !/^\d+(\.\d{1,2})?$/.test(body.price) || Object.hasOwn(body, 'descriptionHtml') && !text(body.descriptionHtml, 1000000)) fail(400, 'PRODUCT_DRAFT_REVIEW_REQUIRED', 'Review the current store, title, optional HTML and price, then explicitly confirm creation of a draft.');
    access(context, profileId);
    // ponytail: this native-store fence shares operation's single-process ceiling; use transactional resource locks before multiple server processes.
    db.exec('CREATE TABLE IF NOT EXISTS zernio_product_creates(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL); CREATE TABLE IF NOT EXISTS zernio_product_create_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,account_id TEXT NOT NULL,native_product_id TEXT,PRIMARY KEY(project_id,request_key))');
    const outcome = await operation(context, async key => {
      const before = await creationSnapshot(context, api, profileId, accountId);
      if (before.version !== body.version) fail(409, 'PRODUCT_STORE_CHANGED', 'The connected store changed. Load and review it again before creating a draft.');
      permission(before.store, 'create');
      if (!text(before.account.platformUserId, 2000) || !before.account.platformUserId.trim() || before.account.platformUserId !== before.account.platformUserId.trim()) fail(409, 'PRODUCT_STORE_IDENTITY_UNAVAILABLE', 'The native store identity could not be verified. Refresh or reconnect this account before creating a product.');
      const ready = await creationSnapshot(context, api, profileId, accountId);
      if (ready.version !== before.version) fail(409, 'PRODUCT_STORE_CHANGED', 'The connected store changed before draft creation. Load and review it again.');
      permission(ready.store, 'create'); access(context, profileId);
      const resource = JSON.stringify(['shopify', ready.account.platformUserId]);
      const previous = db.prepare('SELECT o.status FROM zernio_product_creates p LEFT JOIN integration_operations o ON o.project_id=p.project_id AND o.request_key=p.request_key WHERE p.resource=?').get(resource);
      if (previous && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED', 'This draft was not sent. Review the earlier creation outcome before creating another product in this store.');
      db.prepare('INSERT INTO zernio_product_creates VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      db.prepare('INSERT INTO zernio_product_create_receipts VALUES(?,?,?,NULL)').run(context.project.id, key, accountId);
      const observeReceipt = response => {
        try {
          scope(response, before.account, profileId); scope(response.product, before.account, profileId);
          if (response.product.accountId === accountId && response.product.platform === 'shopify' && identifier(response.product.id)) db.prepare('UPDATE zernio_product_create_receipts SET native_product_id=? WHERE project_id=? AND request_key=?').run(response.product.id, context.project.id, key);
        } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
      };
      const title = body.title.trim(), response = await api('/commerce/products', {}, { accountId, title, ...(Object.hasOwn(body, 'descriptionHtml') ? { descriptionHtml: body.descriptionHtml } : {}), status: 'draft', variants: [{ price: body.price }] }, key, 'POST', observeReceipt);
      try {
        observeReceipt(response);
        access(context, profileId);
        const receipt = productRow(response.product, before.account, profileId, before.store.currency);
        createdDraft(receipt, title, body.price);
        if (Object.hasOwn(body, 'descriptionHtml') && (body.descriptionHtml ? typeof receipt.descriptionHtml !== 'string' : receipt.descriptionHtml !== '' && receipt.descriptionHtml !== null)) fail(502, 'PRODUCT_DRAFT_NOT_CONFIRMED', 'The provider did not confirm the submitted description HTML.');
        const after = await snapshot(context, api, profileId, accountId, receipt.id);
        permission(after.store, 'create'); createdDraft(after.product, title, body.price);
        if (identity(after.account) !== identity(before.account) || JSON.stringify(after.store) !== JSON.stringify(before.store) || after.product.descriptionHtml !== receipt.descriptionHtml || after.product.variants[0].id !== receipt.variants[0].id) fail(502, 'PRODUCT_DRAFT_NOT_CONFIRMED', 'The created draft, store identity or permissions changed before confirmation.');
        access(context, profileId);
        return { accountId, store: after.store, product: after.product, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-product-create:${accountId}`);
    access(context, profileId); send(outcome.status, outcome.data); return true;
  }
  if (deactivate || archive || activate || deleteProduct) {
    const stateAction = deleteProduct ? 'delete' : archive ? 'archive' : activate ? 'activate' : 'deactivate', targetState = archive ? 'archived' : activate ? 'active' : 'draft', confirmation = deleteProduct ? 'confirmDelete' : archive ? 'confirmArchive' : activate ? 'confirmActivate' : 'confirmDeactivate', notConfirmed = deleteProduct ? 'PRODUCT_DELETE_NOT_CONFIRMED' : archive ? 'PRODUCT_ARCHIVE_NOT_CONFIRMED' : activate ? 'PRODUCT_ACTIVATE_NOT_CONFIRMED' : 'PRODUCT_DEACTIVATE_NOT_CONFIRMED';
    if (!object(body) || Object.keys(body).some(key => !['version', confirmation].includes(key)) || body[confirmation] !== true || typeof body.version !== 'string' || body.version.length !== 64 || !/^[a-f0-9]{64}$/.test(body.version)) fail(400, deleteProduct ? 'PRODUCT_DELETE_REVIEW_REQUIRED' : archive ? 'PRODUCT_ARCHIVE_REVIEW_REQUIRED' : activate ? 'PRODUCT_ACTIVATE_REVIEW_REQUIRED' : 'PRODUCT_DEACTIVATE_REVIEW_REQUIRED', deleteProduct ? 'Review the current Archived Shopify product, then explicitly confirm its irreversible permanent deletion.' : archive ? 'Review the current Active or Draft Shopify product, then explicitly confirm archiving it.' : activate ? 'Review the current Draft Shopify product, then explicitly confirm activating it.' : 'Review the current active Shopify product, then explicitly confirm moving it to draft.');
    access(context, profileId);
    // ponytail: the shared native-product fence has operation's single-process ceiling; use transactional resource locks before multiple server processes.
    db.exec('CREATE TABLE IF NOT EXISTS zernio_product_updates(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await snapshot(context, api, profileId, accountId, productId, deleteProduct ? 'archived' : activate ? 'draft' : deactivate ? 'active' : undefined);
      if (archive && (!['active', 'draft'].includes(before.product.status) || before.product.platformStatus !== before.product.status.toUpperCase())) fail(409, 'PRODUCT_STATE_CHANGED', 'Only an exact Active or Draft Shopify product can be archived. Load and review its current details again.');
      if ((archive || activate || deleteProduct ? hash([stateAction, before.version]) : before.version) !== body.version) fail(409, 'PRODUCT_CHANGED', 'The connected store or product changed. Load and review its current details again.');
      permission(before.store, 'status');
      if (!text(before.account.platformUserId, 2000) || !before.account.platformUserId.trim() || before.account.platformUserId !== before.account.platformUserId.trim()) fail(409, 'PRODUCT_STORE_IDENTITY_UNAVAILABLE', 'The native store identity could not be verified. Refresh or reconnect this account before changing a product state.');
      const ready = await snapshot(context, api, profileId, accountId, productId, before.product.status);
      if (ready.version !== before.version) fail(409, 'PRODUCT_CHANGED', 'This product changed before its state could be changed. Load and review it again.');
      permission(ready.store, 'status'); access(context, profileId);
      claimProduct(context, ready.account, productId, key);
      // Zernio has no atomic conditional state update: an external edit after the final read can race this POST.
      const response = await api('/commerce/products/state', {}, { accountId, productIds: [productId], action: stateAction }, key, 'POST');
      try {
        access(context, profileId); scope(response, before.account, profileId);
        if (response.action !== stateAction || !Array.isArray(response.succeeded) || response.succeeded.length !== 1 || response.succeeded[0] !== productId || !Array.isArray(response.failed) || response.failed.length) fail(502, notConfirmed, 'The provider did not confirm the exact requested product state change.');
        if (deleteProduct) {
          const readable = await storeRead(context, api, profileId, before.account);
          permission(readable, 'status');
          if (JSON.stringify(readable) !== JSON.stringify(before.store)) fail(502, notConfirmed, 'The store identity or permissions changed before absence could be checked.');
          let absent = false;
          try { await read(context, api, profileId, before.account, `/commerce/products/${encodeURIComponent(productId)}`, { accountId }); }
          catch (error) { if (error instanceof IntegrationError && error.providerStatus === 404 && error.providerCode === 'product_not_found') absent = true; else throw error; }
          if (!absent) fail(502, notConfirmed, 'The product is still returned by Shopify. Its permanent deletion has not been confirmed.');
          const after = await storeRead(context, api, profileId, before.account);
          permission(after, 'status');
          if (JSON.stringify(after) !== JSON.stringify(before.store)) fail(502, notConfirmed, 'The store identity or permissions changed during the absence check.');
          access(context, profileId);
          return { accountId, store: after, readback: true, deletionAcceptance: { productId, platform: 'shopify', action: 'delete', absenceVerified: true, checkedAt: new Date().toISOString() } };
        }
        const after = await snapshot(context, api, profileId, accountId, productId, targetState);
        permission(after.store, 'status');
        if (identity(after.account) !== identity(before.account) || JSON.stringify(after.store) !== JSON.stringify(before.store)) fail(502, notConfirmed, 'The store identity or permissions changed before confirmation.');
        access(context, profileId);
        return { accountId, product: after.product, store: after.store, version: after.version, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-product-update:${accountId}:${productId}`);
    access(context, profileId); send(outcome.status, outcome.data); return true;
  }
  if (price) {
    if (!object(body) || Object.keys(body).some(key => !['version', 'confirmPrice', 'variantId', 'price'].includes(key)) || body.confirmPrice !== true || !/^[a-f0-9]{64}$/.test(body.version || '') || !identifier(body.variantId) || !text(body.price, 100) || !/^\d+(?:\.\d{1,2})?$/.test(body.price) || /\s/.test(body.price)) fail(400, 'PRODUCT_PRICE_REVIEW_REQUIRED', 'Review one existing variant and its decimal price, then explicitly confirm the price update.');
    access(context, profileId);
    // ponytail: the shared native-product fence has operation's single-process ceiling; use transactional resource locks before multiple server processes.
    db.exec('CREATE TABLE IF NOT EXISTS zernio_product_updates(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await snapshot(context, api, profileId, accountId, productId);
      if (before.version !== body.version) fail(409, 'PRODUCT_CHANGED', 'The connected store or product changed. Load and review its current details again.');
      permission(before.store, 'price'); editable(before.product);
      if (!text(before.account.platformUserId, 2000) || !before.account.platformUserId.trim() || before.account.platformUserId !== before.account.platformUserId.trim()) fail(409, 'PRODUCT_STORE_IDENTITY_UNAVAILABLE', 'The native store identity could not be verified. Refresh or reconnect this account before updating a price.');
      const variant = before.product.variants.find(row => row.id === body.variantId);
      if (!variant) fail(409, 'PRODUCT_VARIANT_CHANGED', 'Choose an existing variant from the freshly reviewed product.');
      if (decimal(variant.price.amount) === decimal(body.price)) fail(400, 'EMPTY_PRODUCT_PRICE_UPDATE', 'Enter a price that changes the selected variant.');
      const ready = await snapshot(context, api, profileId, accountId, productId);
      if (ready.version !== before.version || !ready.product.variants.some(row => row.id === body.variantId && row.price.currency === before.store.currency)) fail(409, 'PRODUCT_CHANGED', 'This product changed before the price update could be sent. Load and review it again.');
      permission(ready.store, 'price'); editable(ready.product); access(context, profileId);
      claimProduct(context, ready.account, productId, key);
      // Zernio has no atomic conditional price update: an external edit after the final read can race this POST.
      const response = await api(`/commerce/products/${encodeURIComponent(productId)}/price`, {}, { accountId, variants: [{ id: body.variantId, price: body.price }] }, key, 'POST');
      try {
        access(context, profileId); scope(response, before.account, profileId);
        const receipt = productRow(response.product, before.account, profileId, before.store.currency, productId);
        const confirmedPrice = product => product.variants.some(row => row.id === body.variantId && row.price.currency === before.store.currency && decimal(row.price.amount) === decimal(body.price));
        editable(receipt);
        if (!confirmedPrice(receipt)) fail(502, 'PRODUCT_PRICE_NOT_CONFIRMED', 'The provider did not confirm the reviewed variant price.');
        const after = await snapshot(context, api, profileId, accountId, productId);
        permission(after.store, 'price'); editable(after.product);
        if (identity(after.account) !== identity(before.account) || JSON.stringify(after.store) !== JSON.stringify(before.store) || !confirmedPrice(after.product)) fail(502, 'PRODUCT_PRICE_NOT_CONFIRMED', 'The selected variant price, store identity or permissions changed before confirmation.');
        access(context, profileId);
        return { accountId, product: after.product, store: after.store, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-product-update:${accountId}:${productId}`);
    access(context, profileId); send(outcome.status, outcome.data); return true;
  }
  if (update) {
    const fields = object(body) ? ['title', 'descriptionHtml', 'vendor', 'productType', 'tags'].filter(key => Object.hasOwn(body, key)) : [];
    // These are local app bounds shared with product reads, not provider limits.
    if (!object(body) || Object.keys(body).some(key => !['version', 'confirmUpdate', 'title', 'descriptionHtml', 'vendor', 'productType', 'tags'].includes(key)) || body.confirmUpdate !== true || !/^[a-f0-9]{64}$/.test(body.version || '') || !fields.length || fields.includes('title') && (!text(body.title, 10000) || !body.title.trim() || /[\r\n\t]/.test(body.title)) || fields.includes('descriptionHtml') && !text(body.descriptionHtml, 1000000) || fields.includes('vendor') && (!text(body.vendor, 10000) || /[\r\n\t]/.test(body.vendor)) || fields.includes('productType') && (!text(body.productType, 10000) || /[\r\n\t]/.test(body.productType)) || fields.includes('tags') && (!Array.isArray(body.tags) || body.tags.length > 1000 || body.tags.some(value => !text(value, 2000)))) fail(400, 'PRODUCT_REVIEW_REQUIRED', 'Review the current product and selected title, description HTML, vendor, product type or complete tag list, then explicitly confirm the update.');
    access(context, profileId);
    // ponytail: this durable native-product fence shares operation's single-process ceiling; use transactional resource locks before multiple server processes.
    db.exec('CREATE TABLE IF NOT EXISTS zernio_product_updates(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await snapshot(context, api, profileId, accountId, productId);
      if (before.version !== body.version) fail(409, 'PRODUCT_CHANGED', 'The connected store or product changed. Load and review its current details again.');
      permission(before.store, 'update');
      editable(before.product);
      if (!text(before.account.platformUserId, 2000) || !before.account.platformUserId.trim() || before.account.platformUserId !== before.account.platformUserId.trim()) fail(409, 'PRODUCT_STORE_IDENTITY_UNAVAILABLE', 'The native store identity could not be verified. Refresh or reconnect this account before updating a product.');
      const changed = Object.fromEntries(fields.map(key => [key, key === 'title' ? body.title.trim() : body[key]]).filter(([key, value]) => key === 'tags' ? !sameTags(value, before.product.tags) : value !== before.product[key]));
      if (!Object.keys(changed).length) fail(400, 'EMPTY_PRODUCT_UPDATE', 'Select at least one field that changes the current product.');
      const ready = await snapshot(context, api, profileId, accountId, productId);
      if (ready.version !== before.version) fail(409, 'PRODUCT_CHANGED', 'This product changed before the update could be sent. Load and review it again.');
      permission(ready.store, 'update');
      editable(ready.product);
      access(context, profileId);
      claimProduct(context, ready.account, productId, key);
      const path = `/commerce/products/${encodeURIComponent(productId)}`;
      // Zernio has no atomic conditional product update: an external edit after the final read can race this PATCH.
      const response = await api(path, {}, { accountId, ...changed }, key, 'PATCH');
      try {
        access(context, profileId); scope(response, before.account, profileId);
        const receipt = productRow(response.product, before.account, profileId, before.store.currency, productId);
        editable(receipt);
        if (Object.hasOwn(changed, 'title') && receipt.title !== changed.title || Object.hasOwn(changed, 'descriptionHtml') && typeof receipt.descriptionHtml !== 'string' || Object.hasOwn(changed, 'vendor') && receipt.vendor !== changed.vendor || Object.hasOwn(changed, 'productType') && receipt.productType !== changed.productType || Object.hasOwn(changed, 'tags') && !sameTags(receipt.tags, changed.tags)) fail(502, 'PRODUCT_UPDATE_NOT_CONFIRMED', 'The provider did not confirm the requested product content.');
        const after = await snapshot(context, api, profileId, accountId, productId);
        permission(after.store, 'update');
        editable(after.product);
        if (identity(after.account) !== identity(before.account) || JSON.stringify(after.store) !== JSON.stringify(before.store) || after.product.title !== receipt.title || after.product.descriptionHtml !== receipt.descriptionHtml || after.product.vendor !== receipt.vendor || after.product.productType !== receipt.productType || !sameTags(after.product.tags, receipt.tags)) fail(502, 'PRODUCT_UPDATE_NOT_CONFIRMED', 'The product content, store identity or permissions changed before confirmation.');
        access(context, profileId);
        return { accountId, product: after.product, store: after.store, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-product-update:${accountId}:${productId}`);
    access(context, profileId); send(outcome.status, outcome.data); return true;
  }
  if (productId !== undefined && productId !== 'store') {
    const { product, store, version } = await snapshot(context, api, profileId, accountId, productId);
    access(context, profileId); send(200, { product, store, version, archiveVersion: hash(['archive', version]), activateVersion: hash(['activate', version]), deleteVersion: hash(['delete', version]), coverage }); return true;
  }
  if (productId === 'store') { const { store, version } = await creationSnapshot(context, api, profileId, accountId); access(context, profileId); send(200, { store, creationVersion: version }); return true; }
  const query = parts.length === 1 ? page(url) : {}, account = await selected(context, api, profileId, accountId), store = await storeRead(context, api, profileId, account);
  permission(store);
  if (query.collectionId !== undefined) collectionPermission(store);
  const collection = query.collectionId === undefined ? undefined : await collectionRead(context, api, profileId, account, query.collectionId);
  const result = await read(context, api, profileId, account, `/commerce/products${productId === undefined ? '' : '/' + encodeURIComponent(productId)}`, { accountId, ...query });
  let response;
  if (productId === undefined) {
    if (!Array.isArray(result.products) || result.products.length > query.limit || result.nextCursor !== null && (!text(result.nextCursor, 4096) || !result.nextCursor || result.nextCursor === query.cursor)) invalid();
    const products = result.products.map(row => productRow(row, account, profileId, store.currency));
    if (new Set(products.map(row => row.id)).size !== products.length) invalid();
    response = { products, nextCursor: result.nextCursor, coverage };
  } else response = { product: productRow(result.product, account, profileId, store.currency, productId), coverage };
  if (collection !== undefined && JSON.stringify(await collectionRead(context, api, profileId, account, query.collectionId)) !== JSON.stringify(collection)) fail(409, 'COLLECTION_CHANGED', 'The collection changed. Load its products again.');
  const after = await storeRead(context, api, profileId, account);
  permission(after);
  if (collection !== undefined) collectionPermission(after);
  if (JSON.stringify(after) !== JSON.stringify(store)) fail(409, 'PRODUCT_STORE_CHANGED', 'The store details or permissions changed. Load its products again.');
  access(context, profileId); send(200, { ...response, ...(collection === undefined ? {} : { accountId, store: after, collection }) }); return true;
}
