# Integración MCP (Model Context Protocol) con Jira

Esta guía explica cómo integrar el servidor MCP de Jira con el sistema de QA Agent.

## ¿Qué es MCP?

Model Context Protocol (MCP) es un protocolo estándar que permite a los modelos de IA acceder a herramientas y contextos externos de manera estructurada y segura.

## Arquitectura con MCP

```
┌─────────────────┐
│   QA Agent      │
│   (Main App)    │
└────────┬────────┘
         │
         │ MCP Protocol
         ▼
┌─────────────────┐
│  Jira MCP       │
│  Server         │
└────────┬────────┘
         │
         │ Jira API
         ▼
┌─────────────────┐
│   Jira Cloud    │
└─────────────────┘
```

## Beneficios de usar MCP

1. ✅ **Abstracción**: Separa la lógica de Jira del código principal
2. ✅ **Reutilización**: El servidor MCP puede usarse en múltiples proyectos
3. ✅ **Versionado**: Cambios en Jira API no afectan el código principal
4. ✅ **Testing**: Más fácil mockear y testear
5. ✅ **Seguridad**: Credenciales aisladas en el servidor MCP
6. ✅ **Fallback**: Si MCP falla, usa API directa automáticamente

## Instalación

### 1. Instalar el Servidor MCP

```bash
cd ./mcp-server-jira
npm install
npm run build
```

### 2. Configurar Credenciales

```bash
cd ./mcp-server-jira
cp .env.example .env
nano .env
```

Completar:
```env
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-jira-api-token
```

### 3. Actualizar Dependencias del Proyecto Principal

```bash
cd /path/to/qatin
npm install @modelcontextprotocol/sdk
```

### 4. Configurar el Cliente Principal

En `.env`, añadir:
```env
# MCP Configuration (opcional)
USE_MCP=true
MCP_JIRA_SERVER_PATH=./mcp-server-jira/dist/index.js
```

## Uso

### Modo Automático (Recomendado)

El cliente detecta automáticamente si MCP está disponible:

```typescript
import { JiraMcpClient } from './clients/jira-mcp-client';

const jiraClient = new JiraMcpClient();

// Usa MCP si está disponible, sino usa API directa
const ticket = await jiraClient.getIssue('PROJ-123');
```

### Verificar si MCP está Activo

```typescript
if (jiraClient.isMcpAvailable()) {
  console.log('✅ Using MCP');
} else {
  console.log('📡 Using Direct API');
}
```

## Herramientas MCP Disponibles

### 1. jira_get_issue

Obtener detalles de un issue:

```typescript
{
  name: 'jira_get_issue',
  arguments: {
    issueKey: 'PROJ-123'
  }
}
```

### 2. jira_search_issues

Buscar issues con JQL:

```typescript
{
  name: 'jira_search_issues',
  arguments: {
    jql: 'status = "Ready for QA"',
    maxResults: 50
  }
}
```

### 3. jira_add_comment

Añadir comentario:

```typescript
{
  name: 'jira_add_comment',
  arguments: {
    issueKey: 'PROJ-123',
    comment: {
      type: 'doc',
      version: 1,
      content: [...]
    }
  }
}
```

### 4. jira_upload_attachment

Subir archivo:

```typescript
{
  name: 'jira_upload_attachment',
  arguments: {
    issueKey: 'PROJ-123',
    filename: 'screenshot.png',
    content: 'base64-encoded-content'
  }
}
```

### 5. jira_add_label

Añadir etiqueta:

```typescript
{
  name: 'jira_add_label',
  arguments: {
    issueKey: 'PROJ-123',
    label: 'qa-passed'
  }
}
```

### 6. jira_transition_issue

Transicionar issue:

```typescript
{
  name: 'jira_transition_issue',
  arguments: {
    issueKey: 'PROJ-123',
    transitionName: 'QA Approved'
  }
}
```

### 7. jira_get_transitions

Obtener transiciones disponibles:

```typescript
{
  name: 'jira_get_transitions',
  arguments: {
    issueKey: 'PROJ-123'
  }
}
```

## Testing del Servidor MCP

### Test Manual

```bash
# Terminal 1: Iniciar servidor MCP
cd ./mcp-server-jira
node dist/index.js

# Terminal 2: Probar con stdio
echo '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}' | node dist/index.js
```

### Test con Cliente

```bash
cd /path/to/qatin
npm run dev

# En otra terminal
curl -X POST http://localhost:8545/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'

# Verificar logs para ver si usa MCP
tail -f logs/server.log | grep MCP
```

## Deployment con MCP

### Opción 1: Systemd Service

Crear servicio para el servidor MCP:

```bash
sudo nano /etc/systemd/system/jira-mcp-server.service
```

```ini
[Unit]
Description=Jira MCP Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=./mcp-server-jira
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ./mcp-server-jira/dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:./logs/mcp-server.log
StandardError=append:./logs/mcp-server-error.log

[Install]
WantedBy=multi-user.target
```

Activar:
```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-mcp-server
sudo systemctl start jira-mcp-server
sudo systemctl status jira-mcp-server
```

### Opción 2: Docker

Añadir al `docker-compose.yml`:

```yaml
services:
  mcp-jira:
    build: ./mcp-server-jira
    container_name: jira-mcp-server
    env_file:
      - ./mcp-server-jira/.env
    restart: unless-stopped
    volumes:
      - ./logs:./logs
```

## Configuración en Cursor

Para usar el servidor MCP en Cursor IDE:

1. Abrir settings de Cursor
2. Ir a "MCP Servers"
3. Añadir configuración:

```json
{
  "jira-qa": {
    "command": "node",
    "args": ["./mcp-server-jira/dist/index.js"],
    "env": {
      "JIRA_URL": "https://your-company.atlassian.net",
      "JIRA_EMAIL": "your-email@company.com",
      "JIRA_API_TOKEN": "your-token"
    }
  }
}
```

## Troubleshooting

### MCP Server no inicia

```bash
# Verificar que está compilado
ls -la ./mcp-server-jira/dist/

# Re-compilar
cd ./mcp-server-jira
npm run build

# Verificar permisos
chmod +x ./mcp-server-jira/dist/index.js
```

### Cliente no detecta MCP

```bash
# Verificar variable de entorno
grep MCP .env

# Verificar logs
tail -f ./logs/server.log | grep -i mcp
```

### Errores de autenticación

```bash
# Verificar credenciales del servidor MCP
cat ./mcp-server-jira/.env

# Probar credenciales manualmente
curl -u "email@example.com:api-token" \
  https://your-domain.atlassian.net/rest/api/3/myself
```

## Ventajas vs API Directa

| Característica | MCP | API Directa |
|----------------|-----|-------------|
| Abstracción | ✅ Alta | ❌ Baja |
| Reutilización | ✅ Multi-proyecto | ❌ Single proyecto |
| Mantenimiento | ✅ Centralizado | ❌ Distribuido |
| Versionado | ✅ Independiente | ❌ Acoplado |
| Fallback | ✅ Automático | N/A |
| Complejidad | ⚠️ Media | ✅ Baja |
| Latencia | ⚠️ +5-10ms | ✅ Directa |

## Recomendación

- **Desarrollo**: Usar API directa (más simple)
- **Producción**: Usar MCP (más robusto y mantenible)
- **Equipos grandes**: Usar MCP (reutilizable)

## Próximos Pasos

1. [ ] Instalar servidor MCP
2. [ ] Configurar credenciales
3. [ ] Probar con ticket de prueba
4. [ ] Monitorear logs para verificar uso de MCP
5. [ ] (Opcional) Crear otros servidores MCP (Slack, GitHub, etc.)

## Referencias

- [MCP Specification](https://modelcontextprotocol.io/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)

---

**Actualizado:** 2024-01-15
