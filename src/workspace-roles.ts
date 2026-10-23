// Campaign's workspace roles and their display labels, shared by Team settings and the invitation screen.
export const workspaceRoles = [{ value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }, { value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }];
export const roleLabel = (role: string) => workspaceRoles.find(option => option.value === role)?.label ?? role;
