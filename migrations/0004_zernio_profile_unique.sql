-- One Zernio profile maps to at most one project. The application checks first for a friendly error; this index
-- closes the race between two parallel mappings, and the server reports its violation as the same conflict.
CREATE UNIQUE INDEX projects_zernio_profile ON projects (zernio_profile_id) WHERE zernio_profile_id <> '';
