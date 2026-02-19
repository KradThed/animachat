<template>
  <div class="authorize-container">
    <div class="authorize-box">
      <div class="authorize-header">
        <div class="status-line">delegate.authorization <span class="pulse">●</span></div>
      </div>

      <div v-if="error" class="error-message">{{ error }}</div>

      <div v-if="!submitting" class="authorize-form">
        <p class="authorize-description">
          A delegate CLI wants to connect to your account.
          Choose a name for this delegate.
        </p>

        <div class="field">
          <label for="namespace">delegate.name</label>
          <input
            id="namespace"
            v-model="namespace"
            type="text"
            placeholder="my-laptop"
            :disabled="submitting"
            @keydown.enter="authorize"
          />
          <div class="field-hint">2-40 chars: lowercase letters, numbers, hyphens</div>
        </div>

        <div class="authorize-actions">
          <button class="btn-cancel" @click="cancel" :disabled="submitting">cancel</button>
          <button class="btn-authorize" @click="authorize" :disabled="!isValid || submitting">
            authorize
          </button>
        </div>
      </div>

      <div v-else class="submitting-state">
        <div class="status-line">authorizing... <span class="pulse">●</span></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/services/api';

const route = useRoute();

// Read query params from CLI redirect
const redirectUri = route.query.redirect_uri as string || '';
const codeChallenge = route.query.code_challenge as string || '';
const codeChallengeMethod = route.query.code_challenge_method as string || '';
const state = route.query.state as string || '';

const namespace = ref('');
const error = ref('');
const submitting = ref(false);

const NAMESPACE_REGEX = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const isValid = computed(() => NAMESPACE_REGEX.test(namespace.value));

// Validate required query params
if (!redirectUri || !codeChallenge || !state) {
  error.value = 'Missing required parameters. Please start the login flow from the CLI.';
}

async function authorize() {
  if (!isValid.value || submitting.value) return;

  error.value = '';
  submitting.value = true;

  try {
    const response = await api.post('/delegates/authorize/confirm', {
      namespace: namespace.value,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod || 'S256',
      state,
    });

    // Redirect to CLI callback with auth code
    window.location.href = response.data.redirectUrl;
  } catch (err: any) {
    submitting.value = false;
    error.value = err.response?.data?.error || 'Authorization failed. Please try again.';
  }
}

function cancel() {
  // Redirect to CLI callback with error
  if (redirectUri && state) {
    window.location.href = `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`;
  } else {
    window.location.href = '/conversation';
  }
}
</script>

<style scoped>
.authorize-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: var(--bg-primary, #0a0a0a);
  color: var(--text-primary, #e0e0e0);
  font-family: 'IBM Plex Mono', 'Fira Code', monospace;
}

.authorize-box {
  width: 100%;
  max-width: 420px;
  padding: 2rem;
  border: 1px solid var(--border-color, #333);
  background: var(--bg-secondary, #111);
}

.authorize-header {
  margin-bottom: 1.5rem;
}

.status-line {
  font-size: 0.85rem;
  color: var(--text-secondary, #888);
  text-transform: lowercase;
}

.pulse {
  color: var(--accent, #4caf50);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.authorize-description {
  font-size: 0.85rem;
  color: var(--text-secondary, #aaa);
  margin-bottom: 1.5rem;
  line-height: 1.5;
}

.field {
  margin-bottom: 1.5rem;
}

.field label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary, #888);
  margin-bottom: 0.4rem;
}

.field input {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: var(--bg-primary, #0a0a0a);
  border: 1px solid var(--border-color, #333);
  color: var(--text-primary, #e0e0e0);
  font-family: inherit;
  font-size: 0.9rem;
  outline: none;
}

.field input:focus {
  border-color: var(--accent, #4caf50);
}

.field-hint {
  font-size: 0.75rem;
  color: var(--text-secondary, #666);
  margin-top: 0.3rem;
}

.authorize-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
}

.authorize-actions button {
  padding: 0.5rem 1.2rem;
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  border: 1px solid var(--border-color, #333);
  background: transparent;
  color: var(--text-primary, #e0e0e0);
}

.authorize-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-authorize {
  background: var(--accent, #4caf50) !important;
  color: #000 !important;
  border-color: var(--accent, #4caf50) !important;
}

.btn-authorize:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-cancel:hover:not(:disabled) {
  border-color: var(--text-secondary, #888);
}

.error-message {
  background: rgba(244, 67, 54, 0.1);
  border: 1px solid rgba(244, 67, 54, 0.3);
  color: #f44336;
  padding: 0.6rem 0.8rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.submitting-state {
  text-align: center;
  padding: 2rem 0;
}
</style>
