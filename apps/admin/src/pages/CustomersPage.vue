<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';
import { can } from '../api/session';

interface Tenant {
  id: string;
  name: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
  installationCount: number;
}

const tenants = ref<Tenant[]>([]);
const dialog = ref<{ open: boolean; editing: Tenant | null }>({ open: false, editing: null });
const form = ref({ name: '', contactName: '', contactPhone: '', contactEmail: '', notes: '' });
const error = ref('');

async function load(): Promise<void> {
  tenants.value = (await api<{ tenants: Tenant[] }>('/tenants')).tenants;
}
onMounted(load);

/** One compact two-column dialog per action — the ERP's house rule, kept here. */
function openNew(): void {
  form.value = { name: '', contactName: '', contactPhone: '', contactEmail: '', notes: '' };
  dialog.value = { open: true, editing: null };
}

function openEdit(tenant: Tenant): void {
  form.value = {
    name: tenant.name,
    contactName: tenant.contactName,
    contactPhone: tenant.contactPhone,
    contactEmail: tenant.contactEmail,
    notes: tenant.notes,
  };
  dialog.value = { open: true, editing: tenant };
}

async function save(): Promise<void> {
  error.value = '';
  try {
    const editing = dialog.value.editing;
    if (editing === null) {
      await api('/tenants', { method: 'POST', body: form.value });
    } else {
      await api(`/tenants/${editing.id}`, { method: 'PUT', body: form.value });
    }
    dialog.value = { open: false, editing: null };
    await load();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not save';
  }
}
</script>

<template>
  <h2>Customers</h2>
  <p class="lede">The businesses you sell to. One customer can have several installations.</p>

  <div style="margin-bottom: 12px">
    <button v-if="can('tenant.manage')" class="ctl primary" @click="openNew">Add customer</button>
  </div>

  <div class="ctl-card">
    <table class="ctl">
      <thead>
        <tr><th>Business</th><th>Contact</th><th>Installations</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="tenant in tenants" :key="tenant.id">
          <td><RouterLink :to="`/customers/${tenant.id}`">{{ tenant.name }}</RouterLink></td>
          <td>
            {{ tenant.contactName }}
            <span v-if="tenant.contactPhone" class="ctl-note"> · {{ tenant.contactPhone }}</span>
          </td>
          <td>{{ tenant.installationCount }}</td>
          <td>
            <button v-if="can('tenant.manage')" class="ctl" @click="openEdit(tenant)">Edit</button>
          </td>
        </tr>
        <tr v-if="tenants.length === 0"><td colspan="4" class="ctl-note">No customers yet.</td></tr>
      </tbody>
    </table>
  </div>

  <div v-if="dialog.open" class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>{{ dialog.editing === null ? 'Add customer' : 'Edit customer' }}</h3>
      <div class="two-col">
        <div>
          <label class="ctl" for="c-name">Business name</label>
          <input id="c-name" v-model="form.name" class="ctl" />
          <label class="ctl" for="c-contact">Contact person</label>
          <input id="c-contact" v-model="form.contactName" class="ctl" />
        </div>
        <div>
          <label class="ctl" for="c-phone">Phone</label>
          <input id="c-phone" v-model="form.contactPhone" class="ctl" />
          <label class="ctl" for="c-email">Email</label>
          <input id="c-email" v-model="form.contactEmail" class="ctl" />
        </div>
      </div>
      <label class="ctl" for="c-notes">Notes</label>
      <textarea id="c-notes" v-model="form.notes" class="ctl" rows="3" />
      <p v-if="error" class="ctl-error">{{ error }}</p>
      <footer>
        <button class="ctl" @click="dialog = { open: false, editing: null }">Cancel</button>
        <button class="ctl primary" :disabled="form.name.trim() === ''" @click="save">Save</button>
      </footer>
    </div>
  </div>
</template>
