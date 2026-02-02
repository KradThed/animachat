# Animachat

Multiuser AI chat application with tool calling support, remote delegate system, and MCP integration. Built on [Membrane](https://github.com/antra-tess/membrane) LLM middleware.

## Architecture

```
animachat-main/          Chat app (Vue 3 frontend + Express backend)
animachat-delegate/      Remote tool execution CLI
membrane/                LLM middleware (git submodule, unmodified)
```

**Tool calling** works through two paths:
- **Server tools** run on the backend (e.g., `get_current_time`)
- **Delegate tools** run on a remote machine via WebSocket, hosting MCP servers

**Supported providers:** Anthropic (direct), OpenRouter, OpenAI-compatible

## Prerequisites

- Node.js >= 20
- npm
- Git

## Setup

### 1. Clone

```bash
git clone --recurse-submodules git@github.com:KradThed/animachat.git
cd animachat
```

If you already cloned without `--recurse-submodules`:
```bash
git submodule update --init --recursive
```

### 2. Build Membrane

```bash
cd membrane
npm install
npm run build
cd ..
```

### 3. Backend

```bash
cd animachat-main/deprecated-claude-app/backend

# Copy and edit environment config
cp env.example .env
# Edit .env - at minimum set your API key:
#   ANTHROPIC_API_KEY=sk-ant-...
#   or OPENROUTER_API_KEY=sk-or-...

# Copy model and site configs
cp config/config.example.json config/config.json
cp config/siteConfig.example.json config/siteConfig.json

npm install
cd ../../..
```

### 4. Frontend

```bash
cd animachat-main/deprecated-claude-app/frontend
npm install
cd ../../..
```

### 5. Delegate (optional)

Only needed if you want remote tool execution or MCP server hosting.

```bash
cd animachat-delegate

# Copy and edit config
cp config/delegate.example.yaml delegate.yaml
# Edit delegate.yaml:
#   - Set server URL (ws://localhost:3010 for local)
#   - Set JWT token (get from browser after logging in)
#   - Configure MCP servers you want to host

npm install
npm run build
cd ..
```

## Running

### Development mode

From `animachat-main/deprecated-claude-app/`:

```bash
npm run dev
```

This starts both backend (port 3010) and frontend (port 5173) with hot reload.

Open http://localhost:5173 in your browser.

### Run individually

```bash
# Backend only
cd animachat-main/deprecated-claude-app/backend
npm run dev

# Frontend only
cd animachat-main/deprecated-claude-app/frontend
npm run dev
```

### Delegate

```bash
cd animachat-delegate
npm run dev
# or
node dist/index.js --config delegate.yaml
```

## Configuration

### API Keys

Set in `backend/.env` or in `backend/config/config.json`. The config file takes precedence.

| Provider | Env var | Format |
|----------|---------|--------|
| Anthropic | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| OpenRouter | `OPENROUTER_API_KEY` | `sk-or-...` |
| OpenAI | `OPENAI_API_KEY` | `sk-...` |

### Delegate

Edit `animachat-delegate/delegate.yaml`:

```yaml
server:
  url: ws://localhost:3010
  token: "YOUR_JWT_TOKEN"    # Get from browser after login

delegate:
  id: "my-machine"
  capabilities: [mcp_host, webhooks]

mcp_servers:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
```

To get the JWT token: log in via the browser, open DevTools > Application > Local Storage, copy the `token` value.

### Webhooks (MCP Live)

The delegate can receive webhooks from GitHub/GitLab and trigger AI inference:

```yaml
webhooks:
  enabled: true
  port: 8080
  endpoints:
    - source: gitlab
      path: /webhooks/gitlab
      secret: "your-webhook-secret"
      conversation_id: "target-conversation-id"
```

## Ports

| Service | Port | Configurable via |
|---------|------|-----------------|
| Backend API / WebSocket | 3010 | `PORT` in `.env` |
| Frontend dev server | 5173 | `VITE_PORT` in frontend `.env` |
| Delegate webhooks | 8080 | `webhooks.port` in `delegate.yaml` |

## Project Structure

```
animachat-main/deprecated-claude-app/
  backend/
    src/
      services/membrane-inference.ts   # LLM integration via Membrane
      tools/server-tools.ts            # Server-side tool definitions
      tools/tool-registry.ts           # Tool registration and routing
      delegate/                        # Delegate WebSocket protocol
      websocket/handler.ts             # Chat WebSocket handler
    config/                            # Model and site configuration
  frontend/
    src/
      components/MessageComponent.vue  # Chat message rendering
      store/index.ts                   # State management
      views/ConversationView.vue       # Main chat view

animachat-delegate/
  src/
    index.ts                           # CLI entry point
    connection.ts                      # WebSocket connection to server
    mcp-host.ts                        # MCP server process manager
    webhook-server.ts                  # HTTP webhook receiver

membrane/                              # Git submodule (do not modify)
```
