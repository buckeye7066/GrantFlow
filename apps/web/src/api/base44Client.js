import { trpcClient } from '@/lib/apiClient';
import {
  mapProfileToOrganization,
  profileInputFromForm,
} from '@/components/organizations/profileTransforms';

const DEFAULT_USER = {
  id: 'local-admin',
  email: import.meta.env.VITE_DEFAULT_ADMIN_EMAIL ?? 'admin@axiombiolabs.org',
  name: 'Local Admin',
  role: 'admin',
};

const getProfiles = async () => {
  const profiles = await trpcClient.profile.list.query();
  return profiles.map(mapProfileToOrganization).filter(Boolean);
};

export const base44 = {
  auth: {
    async me() {
      return DEFAULT_USER;
    },
    redirectToLogin() {
      console.info('[base44Client] redirectToLogin noop');
    },
    logout() {
      console.info('[base44Client] logout noop');
    },
  },
  entities: {
    Organization: {
      async list(sortKey) {
        const organizations = await getProfiles();
        if (sortKey === 'name') {
          organizations.sort((a, b) =>
            (a.name ?? '').localeCompare(b.name ?? '', undefined, {
              sensitivity: 'base',
            }),
          );
        }
        return organizations;
      },
      async filter(filters = {}) {
        let organizations = await getProfiles();

        if (filters.created_by) {
          organizations = organizations.filter(
            (org) => org.created_by === filters.created_by,
          );
        }

        if (filters.id) {
          organizations = organizations.filter((org) => org.id === filters.id);
        }

        return organizations;
      },
      async get(id) {
        const profile = await trpcClient.profile.byId.query(id);
        if (!profile) {
          throw new Error('Profile not found');
        }
        const mapped = mapProfileToOrganization(profile);
        if (!mapped) {
          throw new Error('Failed to map profile');
        }
        return mapped;
      },
      async create(formData) {
        const input = profileInputFromForm(formData, DEFAULT_USER.email);
        const created = await trpcClient.profile.create.mutate(input);
        const mapped = mapProfileToOrganization(created);
        return mapped;
      },
      async update(id, formData) {
        const existing = await trpcClient.profile.byId.query(id);
        const input = profileInputFromForm(formData, DEFAULT_USER.email, existing);
        const updated = await trpcClient.profile.update.mutate({ id, data: input });
        return mapProfileToOrganization(updated);
      },
    },
  },
  functions: {
    async invoke(name, payload = {}) {
      if (name === 'deleteOrganizationWithCascade') {
        const organizationId =
          payload?.organization_id ?? payload?.body?.organization_id;
        if (!organizationId) {
          throw new Error('organization_id is required');
        }
        await trpcClient.profile.delete.mutate(organizationId);
        return { ok: true, success: true };
      }
      throw new Error(`Function ${name} is not implemented in the local bridge.`);
    },
  },
};
