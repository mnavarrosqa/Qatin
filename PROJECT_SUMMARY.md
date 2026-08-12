# 🎉 Jira QA Agent - Sistema Completado

Sistema de agentes QA automatizado que integra Jira + Playwright + IA para testing automático.

## 📦 Lo que se ha creado

### Estructura del Proyecto

```
/agent/
├── src/                           # Código fuente TypeScript
│   ├── server.ts                  # API Server (Express)
│   ├── worker.ts                  # Worker process
│   ├── queue.ts                   # Bull queue configuration
│   ├── agents/
│   │   ├── ticket-analyzer.ts     # Analizador con OpenAI
│   │   └── test-executor.ts       # Ejecutor Playwright
│   ├── clients/
│   │   └── jira-client.ts         # Cliente Jira API
│   └── utils/
│       └── logger.ts              # Winston logger
│
├── scripts/                       # Scripts de utilidad
│   ├── check-status.sh           # Ver estado de servicios
│   ├── test-api.sh               # Test interactivo
│   └── restart-services.sh       # Reiniciar todo
│
├── examples/                      # Ejemplos y guías
│   └── example-ticket.md         # Ejemplo de ticket óptimo
│
├── logs/                         # Logs (se crea en runtime)
├── screenshots/                  # Screenshots (se crea en runtime)
│
├── package.json                  # Dependencias Node.js
├── tsconfig.json                 # Configuración TypeScript
├── .env.example                  # Variables de entorno template
├── deploy.sh                     # Script de deployment
├── docker-compose.yml            # Docker deployment (alternativo)
├── Dockerfile                    # Container image
│
├── README.md                     # Documentación completa
├── QUICKSTART.md                 # Guía rápida 5 minutos
├── ARCHITECTURE.md               # Arquitectura técnica
└── LICENSE                       # MIT License
```

## 🚀 Cómo Empezar

### Opción 1: Ubuntu Server (Producción)

```bash
# 1. Configurar credenciales
cp .env.example .env
nano .env  # Editar con tus keys

# 2. Desplegar
sudo ./deploy.sh

# 3. Verificar
curl http://localhost:8545/health

# 4. Probar
curl -X POST http://localhost:8545/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

### Opción 2: Docker (Desarrollo)

```bash
# 1. Configurar
cp .env.example .env
nano .env

# 2. Iniciar
docker-compose up -d

# 3. Ver logs
docker-compose logs -f
```

## 🎯 Flujo de Trabajo

```
┌─────────────────┐
│  Usuario o      │
│  Webhook Jira   │
└────────┬────────┘
         │
         │ POST /api/test-ticket {"ticketId": "PROJ-123"}
         ▼
┌─────────────────┐
│  API Server     │
│  (Express)      │
└────────┬────────┘
         │
         │ Enqueue job
         ▼
┌─────────────────┐
│  Redis Queue    │
└────────┬────────┘
         │
         │ Worker consume
         ▼
┌─────────────────────────────────────┐
│  Worker Process                     │
│                                     │
│  1️⃣ Fetch ticket from Jira         │
│  2️⃣ Analyze with OpenAI GPT-4      │
│  3️⃣ Generate test scenarios        │
│  4️⃣ Execute with Playwright        │
│  5️⃣ Capture screenshots            │
│  6️⃣ Post results to Jira           │
│  7️⃣ Upload screenshots             │
│  8️⃣ Add labels & transition        │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Jira Comment   │
│  ✅ PASSED      │
│  📸 Screenshots │
└─────────────────┘
```

## 📊 Características Implementadas

### ✅ Core Features

- **API REST completa** con Express
- **Queue system** con Bull y Redis
- **3 workers** procesando en paralelo
- **Análisis con IA** (OpenAI GPT-4)
- **Tests automatizados** con Playwright
- **Screenshots en cada paso**
- **Comentarios en Jira** con formato rico
- **Upload de screenshots** como attachments
- **Auto-labeling** (qa-passed/qa-failed)
- **Transiciones automáticas** de issues

### ✅ Deployment

- **Systemd services** para Ubuntu
- **Docker support** con docker-compose
- **Scripts de utilidad** (status, restart, test)
- **Log rotation** configurado
- **Health checks** en todos los servicios

### ✅ Integración MCP

- **Servidor MCP** para Jira
- **Cliente híbrido** (MCP + API directa)
- **Fallback automático** si MCP no disponible
- **7 herramientas MCP** (get_issue, search, comment, etc.)

### ✅ Documentación

- **README.md** completo con ejemplos
- **QUICKSTART.md** guía de 5 minutos
- **ARCHITECTURE.md** documentación técnica
- **MCP_INTEGRATION.md** guía de MCP
- **Example tickets** con best practices
- **Inline comments** en código

## 🔧 Variables de Entorno Requeridas

```env
# Jira (OBLIGATORIO)
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token

# OpenAI (OBLIGATORIO)
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4-turbo-preview

# App URLs (OBLIGATORIO)
APP_BASE_URL=https://your-app.com

# Redis (OPCIONAL - defaults a localhost)
REDIS_HOST=localhost
REDIS_PORT=6379

# Playwright (OPCIONAL)
HEADLESS=true
BROWSER_TIMEOUT=30000
MAX_CONCURRENT_TESTS=3
```

## 🎨 Ejemplo de Uso

### 1. Ticket en Jira

```
Ticket: USER-123
Summary: Add login form

Description:
As a user I want to login with email/password

Acceptance Criteria:
- Valid email required
- Password min 8 characters
- Show error for invalid credentials
- Redirect to /dashboard on success
```

### 2. Trigger Test

```bash
curl -X POST http://localhost:8545/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "USER-123"}'
```

### 3. El Sistema:

1. ✅ Fetch ticket de Jira
2. ✅ Analiza con IA: "Este ticket requiere tests de login form"
3. ✅ Genera 4 escenarios:
   - Test email validation
   - Test password validation
   - Test invalid credentials
   - Test successful login
4. ✅ Ejecuta con Playwright:
   - Navigate to /login
   - Fill forms
   - Click buttons
   - Verify redirects
5. ✅ Captura 12 screenshots (3 pasos × 4 escenarios)
6. ✅ Postea en Jira:
   ```
   ✅ PASSED - 4/4 tests passed
   Execution Time: 15.3s
   
   [Detailed report]
   [12 screenshots attached]
   ```

### 4. Resultado en Jira

El ticket ahora tiene:
- ✅ Comentario con resultados
- 📸 12 screenshots adjuntos
- 🏷️ Label "qa-passed"
- 🔄 Transición a "QA Approved"

## 🛠️ Scripts Útiles

```bash
# Ver estado de todo
./scripts/check-status.sh

# Reiniciar servicios
./scripts/restart-services.sh

# Test interactivo
./scripts/test-api.sh

# Ver logs en vivo
journalctl -u jira-qa-server -f

# Ver jobs en Redis
redis-cli
> LLEN bull:jira-qa-tests:waiting
> LLEN bull:jira-qa-tests:active
```

## 📈 Próximos Pasos Sugeridos

### Configuración Inicial
1. [ ] Obtener Jira API token
2. [ ] Obtener OpenAI API key
3. [ ] Configurar .env
4. [ ] Ejecutar deploy.sh
5. [ ] Probar con ticket real

### Integración
6. [ ] (Opcional) Setup MCP: `./scripts/setup-mcp.sh`
7. [ ] Configurar webhook en Jira
8. [ ] Ajustar URLs de testing
9. [ ] Configurar credenciales de test (si tu app requiere login)

### Optimización
9. [ ] Ajustar workers según carga
10. [ ] Setup monitoring (opcional)
11. [ ] Configurar nginx + HTTPS (opcional)

### Personalización
12. [ ] Modificar prompts de IA según tus necesidades
13. [ ] Añadir steps custom de Playwright
14. [ ] Personalizar formato de comentarios

## 🐛 Troubleshooting Rápido

| Problema | Solución |
|----------|----------|
| "Connection refused" | `sudo systemctl start jira-qa-server` |
| "Jira auth failed" | Verificar JIRA_API_TOKEN en .env |
| "OpenAI error" | Verificar OPENAI_API_KEY y saldo |
| "Browser timeout" | Aumentar BROWSER_TIMEOUT en .env |
| Workers stuck | `sudo systemctl restart jira-qa-worker@{1..3}` |

## 📚 Recursos

- [README.md](README.md) - Documentación completa
- [QUICKSTART.md](QUICKSTART.md) - Guía rápida
- [ARCHITECTURE.md](ARCHITECTURE.md) - Detalles técnicos
- [examples/example-ticket.md](examples/example-ticket.md) - Ejemplos

## 🎯 Métricas de Éxito

Después de deployment exitoso deberías ver:

```bash
$ ./scripts/check-status.sh

=== Jira QA Agent Status ===

📡 Server Status: ✅ Running
👷 Workers Status:
  Worker 1: ✅ Running
  Worker 2: ✅ Running
  Worker 3: ✅ Running
🔴 Redis Status: ✅ Running

$ curl http://localhost:8545/health
{"status":"ok","timestamp":"2024-01-15T10:30:00.000Z"}
```

## 💡 Tips

1. **Primeros Tests**: Empieza con tickets simples (login, forms)
2. **Iteración**: Ajusta prompts de IA según resultados
3. **Monitoreo**: Revisa logs regularmente al inicio
4. **Screenshots**: Se limpian automáticamente después de 30 días
5. **Workers**: Empieza con 3, escala según necesidad

## 🎉 ¡Sistema Listo!

El sistema está completamente implementado y listo para usar. Solo falta:
1. Configurar tus credenciales en `.env`
2. Ejecutar `sudo ./deploy.sh`
3. ¡Empezar a testear tickets!

---

**Creado**: 2024-01-15
**Stack**: TypeScript + Node.js + Express + Bull + Redis + Playwright + OpenAI
**Deployment**: Ubuntu Server con systemd
