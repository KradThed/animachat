import axios, { AxiosInstance } from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only logout on 401 (unauthorized/token expired)
    // 403 means "forbidden" - user is authenticated but doesn't have permission for this resource
    if (error.response?.status === 401) {
      // Token expired or invalid
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// =============================================================================
// Tool Registry API
// =============================================================================

export interface ToolInfo {
  name: string;
  description: string;
  source: 'server' | 'delegate';
  delegateName?: string;  // normalized (lowercase) delegate name
}

export interface DelegateCapabilities {
  managedInstall: boolean;   // Can install MCP servers
  canFileAccess: boolean;    // Can read/write config files
  canShellAccess: boolean;   // Can spawn processes
}

export interface DelegateInfo {
  delegateId: string;
  userId: string;
  tools: ToolInfo[];          // Full tool list
  connectedAt: string;        // ISO string
  capabilities: DelegateCapabilities;
}

/**
 * Get all available tools for the current user
 */
export async function getAvailableTools(): Promise<{ tools: ToolInfo[] }> {
  const response = await api.get('/tools');
  return response.data;
}

/**
 * Get connected delegates for the current user
 */
export async function getConnectedDelegates(): Promise<{ delegates: DelegateInfo[] }> {
  const response = await api.get('/tools/delegates');
  return response.data;
}

// =============================================================================
// Feature Set API
// =============================================================================

export interface FeatureSetSummary {
  name: string;
  description?: string;
  uses: string[];
  runtimeEnabled: boolean;        // effective: enabled AND not quarantined
  quarantined: boolean;           // blocked due to unsupported uses declaration
  conversationEnabled?: boolean;  // only when conversationId provided
  visible?: boolean;              // runtimeEnabled && conversationEnabled
  totalToolCount: number;         // all delegate tools tagged with this featureSet
  visibleToolCount?: number;      // only when conversationId provided
}

export interface DelegateFeatureSets {
  delegateId: string;
  featureSets: FeatureSetSummary[];
}

/**
 * Get feature sets grouped by delegate, with optional conversation-scoped state.
 */
export async function getDelegateFeatureSets(conversationId?: string): Promise<{ delegates: DelegateFeatureSets[] }> {
  const params = conversationId ? { conversationId } : {};
  const response = await api.get('/tools/delegate-feature-sets', { params });
  return response.data;
}

/**
 * Get visible tools for the current user, optionally filtered by conversation.
 */
export async function getVisibleTools(conversationId?: string): Promise<{ tools: ToolInfo[] }> {
  const params = conversationId ? { conversationId } : {};
  const response = await api.get('/tools/visible', { params });
  return response.data;
}

/**
 * Enable a feature set for a conversation.
 */
export async function enableFeatureSet(delegateId: string, featureSet: string, conversationId: string): Promise<void> {
  await api.post('/tools/feature-sets/enable', { delegateId, featureSet, conversationId });
}

/**
 * Disable a feature set for a conversation.
 */
export async function disableFeatureSet(delegateId: string, featureSet: string, conversationId: string): Promise<void> {
  await api.post('/tools/feature-sets/disable', { delegateId, featureSet, conversationId });
}

// =============================================================================
// Delegate API Keys
// =============================================================================

export interface DelegateApiKeyPublic {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isRevoked: boolean;
  revokedAt: string | null;
  scopes: string[];
}

export interface CreateDelegateApiKeyResponse {
  key: DelegateApiKeyPublic;
  secretKey: string;
  warning: string;
}

/**
 * Get all delegate API keys for the current user
 */
export async function getDelegateApiKeys(): Promise<{ keys: DelegateApiKeyPublic[] }> {
  const response = await api.get('/tools/api-keys');
  return response.data;
}

/**
 * Create a new delegate API key
 * Returns the secret key only once on creation!
 */
export async function createDelegateApiKey(name: string, expiresAt?: string | null): Promise<CreateDelegateApiKeyResponse> {
  const response = await api.post('/tools/api-keys', { name, expiresAt });
  return response.data;
}

/**
 * Revoke a delegate API key
 */
export async function revokeDelegateApiKey(keyId: string): Promise<{ success: boolean; message: string }> {
  const response = await api.delete(`/tools/api-keys/${keyId}`);
  return response.data;
}

// =============================================================================
// Delegate Entities
// =============================================================================

export interface DelegateEntityKey {
  id: string;
  keyPrefix: string;
  createdAt: string;
}

export interface DelegateEntity {
  id: string;
  namespace: string;
  createdAt: string;
  lastSeenAt: string | null;
  isConnected: boolean;
  toolCount: number;
  keys: DelegateEntityKey[];
}

export async function getDelegateEntities(): Promise<{ delegates: DelegateEntity[] }> {
  const response = await api.get('/delegates');
  return response.data;
}

export async function createDelegateEntity(namespace: string): Promise<{ id: string; namespace: string; created: boolean }> {
  const response = await api.post('/delegates', { namespace });
  return response.data;
}

export async function createDelegateEntityKey(delegateId: string): Promise<{ keyId: string; keyPrefix: string; secretKey: string; warning: string }> {
  const response = await api.post(`/delegates/${delegateId}/keys`);
  return response.data;
}

export async function revokeDelegateEntityKey(keyId: string): Promise<{ success: boolean }> {
  const response = await api.delete(`/delegates/keys/${keyId}`);
  return response.data;
}

export async function deleteDelegateEntity(delegateId: string): Promise<{ success: boolean }> {
  const response = await api.delete(`/delegates/${delegateId}`);
  return response.data;
}

/**
 * Test a tool with empty input (10s timeout)
 */
export async function testTool(toolName: string): Promise<{ success: boolean; content: string }> {
  const response = await api.post('/tools/test', { toolName });
  return response.data;
}
