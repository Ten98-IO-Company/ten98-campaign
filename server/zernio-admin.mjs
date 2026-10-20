import { IntegrationError, operation, scopedAccounts, requireAccount } from './provider-core.ts';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const plain = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const sameIds = (left, right) => left.length === right.length && left.every(value => right.includes(value));
const timezone = value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } };

function profile(row, profileId) {
  if (!object(row) || row._id !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a different profile.');
  if (!plain(row.name, 200) || row.description != null && !plain(row.description, 4000, true) || row.color != null && !plain(row.color, 100) || row.timezone != null && (typeof row.timezone !== 'string' || !timezone(row.timezone))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable profile settings.');
  return { _id: profileId, name: row.name, description: row.description ?? null, color: row.color ?? '#64748b', timezone: row.timezone ?? null };
}
function group(row) {
  if (!object(row) || !validId(row._id) || !plain(row.name, 200) || !Array.isArray(row.accountIds) || row.accountIds.length > 1000 || row.accountIds.some(value => !validId(value)) || new Set(row.accountIds).size !== row.accountIds.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable account group.');
  return { _id: row._id, name: row.name, accountIds: row.accountIds };
}
async function groupRows(api) {
  const response = await api('/account-groups');
  if (!Array.isArray(response.groups) || response.groups.length > 10000) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an account group list.');
  const rows = response.groups.map(group);
  if (new Set(rows.map(row => row._id)).size !== rows.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate account groups.');
  return rows;
}
function projectGroups(rows, accounts) {
  const allowed = new Set(accounts.map(account => account._id));
  // Groups are global upstream. Empty and mixed-profile groups have no safe project ownership.
  return rows.filter(row => row.accountIds.length && row.accountIds.every(id => allowed.has(id)));
}
async function groups(api, accounts) { return projectGroups(await groupRows(api), accounts); }
function members(value, accounts) {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some(id => !validId(id)) || new Set(value).size !== value.length) fail(400, 'INVALID_GROUP_ACCOUNTS', 'Choose at least one distinct account from this project.');
  value.forEach(id => requireAccount(accounts, id)); return value;
}
function expectedGroup(value, current) {
  if (!object(value) || !plain(value.name, 200) || !Array.isArray(value.accountIds) || value.accountIds.some(id => !validId(id)) || new Set(value.accountIds).size !== value.accountIds.length) fail(400, 'GROUP_SNAPSHOT_REQUIRED', 'Refresh the account group before changing it.');
  if (value.name !== current.name || !sameIds(value.accountIds, current.accountIds)) fail(409, 'GROUP_CHANGED', 'This account group changed. Refresh before making another change.');
}
function uncertain(error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }

function providerTeam(value) {
  if (!object(value) || !validId(value.currentUserId) || !Array.isArray(value.users) || !value.users.length || value.users.length > 10000) fail(502, 'INVALID_PROVIDER_TEAM', 'Zernio did not return a readable provider team.');
  const users = value.users.map(row => {
    if (!object(row) || !validId(row._id) || !plain(row.name, 200) || !plain(row.email, 320) || !plain(row.role, 100) || row.isRoot != null && typeof row.isRoot !== 'boolean') fail(502, 'INVALID_PROVIDER_TEAM', 'Zernio returned an unreadable provider member.');
    if (row.profileAccess != null && (!Array.isArray(row.profileAccess) || row.profileAccess.length > 1000 || row.profileAccess.some(id => !validId(id)) || new Set(row.profileAccess).size !== row.profileAccess.length || row.profileAccess.includes('all') && row.profileAccess.length !== 1)) fail(502, 'INVALID_PROVIDER_TEAM', 'Zernio returned unreadable provider profile access.');
    for (const key of ['createdAt', 'lastLoginAt']) if (row[key] != null && (!plain(row[key], 100) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row[key]) || !Number.isFinite(Date.parse(row[key])))) fail(502, 'INVALID_PROVIDER_TEAM', 'Zernio returned an unreadable provider member date.');
    return { _id: row._id, name: row.name, email: row.email, role: row.role, isRoot: row.isRoot ?? null, profileAccess: row.profileAccess ?? null, createdAt: row.createdAt ?? null, lastLoginAt: row.lastLoginAt ?? null };
  });
  if (new Set(users.map(row => row._id)).size !== users.length || users.filter(row => row._id === value.currentUserId).length !== 1) fail(502, 'INVALID_PROVIDER_TEAM', 'Zernio did not identify one distinct provider caller.');
  return { currentUserId: value.currentUserId, users };
}

export async function handleZernioAdmin(context, api, profileId, action) {
  const { req, body, role, send } = context;
  if (action === 'team') {
    if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Provider team members can only be read here.');
    const assertAccess = () => {
      if (!context.user?.id || !context.user.isOperator || !['owner', 'admin'].includes(role) || !context.db.prepare('SELECT 1 FROM instance_operators WHERE user_id=?').get(context.user.id)) fail(403, 'OPERATOR_REQUIRED', 'An app administrator who manages this workspace must read provider team members.');
      try { context.assertProjectMapping(profileId); }
      catch (error) { fail([403, 404].includes(error.status) ? 403 : 409, 'PROVIDER_TEAM_ACCESS_CHANGED', 'Your access or provider connection changed. Refresh before reading provider team members.'); }
    };
    assertAccess();
    let result;
    try { result = await api('/users'); }
    catch (error) {
      if (error instanceof IntegrationError && error.providerStatus === 403) fail(403, 'PROVIDER_TEAM_FORBIDDEN', 'Zernio did not allow this credential to read provider team members. Check access in Zernio.');
      throw error;
    } finally { assertAccess(); }
    send(200, providerTeam(result)); return true;
  }
  if (action === 'overview' && req.method === 'GET') {
    const accounts = await scopedAccounts(api, profileId), current = profile((await api(`/profiles/${encodeURIComponent(profileId)}`)).profile, profileId), rows = await groups(api, accounts);
    send(200, { profile: current, groups: rows, accounts: accounts.map(row => ({ _id: row._id, platform: row.platform, displayName: row.displayName, username: row.username, isActive: row.isActive })) }); return true;
  }
  const match = action.match(/^groups\/([^/]+)\/(update|delete)$/), isProfile = action === 'profile/update', create = action === 'groups/create';
  if (req.method !== 'POST' || !isProfile && !create && !match) return false;
  if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_REQUIRED', 'A workspace owner or administrator must change Zernio profile settings and account groups.');
  if (!object(body)) fail(400, 'INVALID_SETTINGS', 'Provide valid profile or group settings.');
  if (isProfile) {
    if (Object.keys(body).some(key => !['name', 'description', 'color', 'timezone', 'expectedProfile'].includes(key))) fail(400, 'INVALID_PROFILE_UPDATE', 'Only this project’s profile name, description, color and timezone can be changed here.');
    const patch = Object.fromEntries(['name', 'description', 'color', 'timezone'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    if (!Object.keys(patch).length || patch.name !== undefined && !plain(patch.name, 200) || patch.description !== undefined && patch.description !== null && !plain(patch.description, 4000, true) || patch.color !== undefined && !plain(patch.color, 100) || patch.timezone !== undefined && patch.timezone !== null && (typeof patch.timezone !== 'string' || !timezone(patch.timezone))) fail(400, 'INVALID_PROFILE_UPDATE', 'Use a profile name, description, color and valid IANA timezone.');
    if (!object(body.expectedProfile)) fail(400, 'PROFILE_SNAPSHOT_REQUIRED', 'Refresh this profile before changing it.');
    const outcome = await operation(context, async key => {
      const current = profile((await api(`/profiles/${encodeURIComponent(profileId)}`)).profile, profileId);
      if (['_id', 'name', 'description', 'color', 'timezone'].some(name => body.expectedProfile[name] !== current[name])) fail(409, 'PROFILE_CHANGED', 'The provider profile changed. Refresh before saving.');
      const response = await api(`/profiles/${encodeURIComponent(profileId)}`, {}, patch, key, 'PUT');
      try {
        const receipt = profile(response.profile, profileId), fresh = profile((await api(`/profiles/${encodeURIComponent(profileId)}`)).profile, profileId);
        if (Object.entries(patch).some(([name, value]) => receipt[name] !== value || fresh[name] !== value)) fail(502, 'PROFILE_CHANGE_NOT_CONFIRMED', 'Zernio has not confirmed these profile settings.');
        return { profile: fresh };
      } catch (error) { uncertain(error); }
    }, `zernio-profile:${profileId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (Object.keys(body).some(key => !(match?.[2] === 'delete' ? ['confirmGroupId', 'expectedGroup'] : ['name', 'accountIds', 'expectedGroup']).includes(key))) fail(400, 'INVALID_GROUP_UPDATE', 'Provide only the account group name and selected accounts.');
  let groupId = ''; try { groupId = match ? decodeURIComponent(match[1]) : ''; } catch { fail(400, 'INVALID_GROUP', 'Choose a valid account group.'); }
  const task = match?.[2] || 'create';
  if (match && !validId(groupId)) fail(400, 'INVALID_GROUP', 'Choose a valid account group.');
  if (task === 'delete' && body.confirmGroupId !== groupId) fail(400, 'GROUP_CONFIRMATION_REQUIRED', 'Confirm the selected account group before deleting it.');
  if (task !== 'delete' && (!plain(body.name, 200) || !Array.isArray(body.accountIds))) fail(400, 'INVALID_GROUP_UPDATE', 'Provide an account group name and select its accounts.');
  const outcome = await operation(context, async key => {
    const accounts = await scopedAccounts(api, profileId), allBefore = await groupRows(api), before = projectGroups(allBefore, accounts), current = before.find(row => row._id === groupId);
    if (task !== 'create') { if (!current) fail(403, 'GROUP_OUTSIDE_PROJECT', 'This account group does not belong entirely to this project.'); expectedGroup(body.expectedGroup, current); }
    const input = task === 'delete' ? undefined : { name: body.name.trim(), accountIds: members(body.accountIds, accounts) };
    const response = await api(task === 'create' ? '/account-groups' : `/account-groups/${encodeURIComponent(groupId)}`, {}, input, key, task === 'delete' ? 'DELETE' : task === 'update' ? 'PUT' : 'POST');
    try {
      if (task === 'delete') {
        if (typeof response.message !== 'string' || !response.message.trim() || response.message.length > 2000) fail(502, 'GROUP_CHANGE_NOT_CONFIRMED', 'Zernio did not confirm the account group deletion.');
        if ((await groupRows(api)).some(row => row._id === groupId)) fail(502, 'GROUP_CHANGE_NOT_CONFIRMED', 'This account group is still present in Zernio.');
        return { groupId, deleted: true };
      }
      const receipt = group(response.group);
      if (task === 'update' && receipt._id !== groupId || task === 'create' && allBefore.some(row => row._id === receipt._id) || receipt.name !== input.name || !sameIds(receipt.accountIds, input.accountIds)) fail(502, 'GROUP_CHANGE_NOT_CONFIRMED', 'Zernio did not confirm the requested account group.');
      const fresh = (await groups(api, await scopedAccounts(api, profileId))).find(row => row._id === receipt._id);
      if (!fresh || fresh.name !== input.name || !sameIds(fresh.accountIds, input.accountIds)) fail(502, 'GROUP_CHANGE_NOT_CONFIRMED', 'Zernio did not return the saved account group.');
      return { group: fresh };
    } catch (error) { uncertain(error); }
  }, `zernio-groups:${profileId}`);
  send(outcome.status, outcome.data); return true;
}
