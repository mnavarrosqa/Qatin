# 🔌 Guía Rápida: Setup MCP para Jira

Esta guía te ayudará a configurar el servidor MCP de Jira en 5 minutos.

## ¿Por qué usar MCP?

**MCP (Model Context Protocol)** es un estándar que permite separar la integración con servicios externos del código principal.

### Ventajas:

✅ **Modular**: Cambios en Jira API no afectan tu código  
✅ **Reutilizable**: Usa el mismo servidor MCP en múltiples proyectos  
✅ **Robusto**: Fallback automático a API directa si falla  
✅ **Seguro**: Credenciales aisladas en el servidor MCP  
✅ **Mantenible**: Versionado independiente  

## Setup en 3 Pasos

### Paso 1: Instalar

```bash
cd /agent
./scripts/setup-mcp.sh
```

Este script:
- ✅ Instala dependencias del servidor MCP
- ✅ Compila el código TypeScript
- ✅ Crea archivos de configuración
- ✅ Actualiza el proyecto principal

### Paso 2: Configurar Credenciales

```bash
nano mcp-server-jira/.env
```

Completa:
```env
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-jira-api-token
```

💡 **Tip**: Genera el API token en https://id.atlassian.com/manage-profile/security/api-tokens

### Paso 3: Activar en el Proyecto Principal

Ya está configurado automáticamente en `.env`:
```env
USE_MCP=true
MCP_JIRA_SERVER_PATH=/agent/mcp-server-jira/dist/index.js
```

## Verificar Funcionamiento

### 1. Reiniciar Servicios

```bash
./scripts/restart-services.sh
```

### 2. Testear un Ticket

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

### 3. Verificar en Logs

```bash
tail -f logs/server.log | grep -i mcp
```

Deberías ver:
```
2024-01-15 10:30:00 [info]: MCP Jira server detected, initializing...
2024-01-15 10:30:00 [info]: MCP Jira client initialized successfully
2024-01-15 10:30:05 [debug]: Calling MCP tool: jira_get_issue
```

## Herramientas MCP Disponibles

El servidor MCP proporciona 7 herramientas:

| Herramienta | Descripción |
|-------------|-------------|
| `jira_get_issue` | Obtener detalles de un ticket |
| `jira_search_issues` | Buscar tickets con JQL |
| `jira_add_comment` | Añadir comentario |
| `jira_upload_attachment` | Subir screenshot |
| `jira_add_label` | Añadir etiqueta |
| `jira_transition_issue` | Cambiar estado |
| `jira_get_transitions` | Ver transiciones disponibles |

## Deployment en Producción

### Opción A: Systemd Service (Recomendado)

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
WorkingDirectory=/agent/mcp-server-jira
ExecStart=/usr/bin/node /agent/mcp-server-jira/dist/index.js
Restart=always
StandardOutput=append:/agent/logs/mcp-server.log
StandardError=append:/agent/logs/mcp-server-error.log

[Install]
WantedBy=multi-user.target
```

Activar:
```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-mcp-server
sudo systemctl start jira-mcp-server
```

### Opción B: Docker

Ya está incluido en `docker-compose.yml` - solo necesitas:

```bash
docker-compose up -d
```

## Uso en el Código

### Automático (Recomendado)

El cliente detecta automáticamente si MCP está disponible:

```typescript
import { JiraMcpClient } from './clients/jira-mcp-client';

const jira = new JiraMcpClient();
const ticket = await jira.getIssue('PROJ-123'); // Usa MCP si disponible
```

### Manual

```typescript
import { JiraMcpClient } from './clients/jira-mcp-client';

const jira = new JiraMcpClient();

// Verificar si MCP está activo
if (jira.isMcpAvailable()) {
  console.log('✅ Using MCP');
} else {
  console.log('📡 Using Direct API (fallback)');
}
```

## Troubleshooting

### MCP no se detecta

```bash
# Verificar que el servidor está compilado
ls -la mcp-server-jira/dist/index.js

# Recompilar si es necesario
cd mcp-server-jira
npm run build
cd ..
```

### Errores de autenticación

```bash
# Verificar credenciales
cat mcp-server-jira/.env

# Probar manualmente
curl -u "email:token" https://your-domain.atlassian.net/rest/api/3/myself
```

### Ver logs del servidor MCP

```bash
# Si usas systemd
journalctl -u jira-mcp-server -f

# Si usas logs directos
tail -f logs/mcp-server.log
```

## Comparación: MCP vs API Directa

| Aspecto | Con MCP | Sin MCP |
|---------|---------|---------|
| **Setup** | 5 minutos extra | Incluido |
| **Mantenimiento** | Centralizado | En cada proyecto |
| **Reutilización** | Multi-proyecto | Single proyecto |
| **Robustez** | Fallback automático | Sin fallback |
| **Latencia** | +5-10ms | Directa |
| **Complejidad** | Media | Baja |

## ¿Cuándo usar MCP?

### ✅ USA MCP si:

- Tienes múltiples proyectos que usan Jira
- Quieres separar la lógica de integración
- Necesitas versionado independiente
- Trabajas en equipo grande
- Planeas usar más servicios MCP (Slack, GitHub, etc.)

### 📡 USA API Directa si:

- Proyecto pequeño/prototipo
- Solo este proyecto usa Jira
- Quieres simplicidad máxima
- No necesitas reutilización

## Próximos Pasos

1. ✅ Instalaste el servidor MCP
2. ✅ Configuraste credenciales
3. ✅ Testeaste funcionamiento
4. 📚 Lee [MCP_INTEGRATION.md](MCP_INTEGRATION.md) para detalles avanzados
5. 🚀 Considera añadir más servidores MCP (Slack, GitHub, etc.)

## Recursos Adicionales

- 📘 [Model Context Protocol Spec](https://modelcontextprotocol.io/)
- 🔧 [MCP SDK GitHub](https://github.com/modelcontextprotocol/sdk)
- 📖 [Jira Cloud API Docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- 📁 [MCP Integration Guide](MCP_INTEGRATION.md) (este proyecto)

---

**¿Necesitas ayuda?** Abre un issue en GitHub o consulta [MCP_INTEGRATION.md](MCP_INTEGRATION.md)
