# Jira QA Agent 🤖

Sistema automatizado de testing QA que lee tickets de Jira, ejecuta tests con Playwright, y publica resultados con screenshots como evidencia.

## 🎯 Características

- **Análisis Inteligente**: Usa IA (OpenAI GPT-4) para analizar tickets y generar estrategias de testing
- **Testing Automatizado**: Ejecuta tests UI con Playwright y captura screenshots
- **Integración Jira**: Lee tickets y publica resultados directamente en comentarios
- **MCP Support**: Integración con Model Context Protocol para mayor flexibilidad
- **Procesamiento Paralelo**: Múltiples workers para ejecutar tests concurrentemente
- **Queue System**: Sistema de colas robusto con Bull y Redis
- **Screenshots con Anotaciones**: Captura evidencia visual de cada paso
- **API REST**: Endpoints para triggering manual o integración con CI/CD
- **Webhook Support**: Auto-trigger cuando tickets cambian a "Ready for QA"

## 🏗️ Arquitectura

```
┌─────────────────┐
│   Jira API      │
└────────┬────────┘
         │
         │ 1. Fetch ticket
         ▼
┌─────────────────┐
│  API Server     │◄─── HTTP POST /api/test-ticket
│  (Express)      │
└────────┬────────┘
         │
         │ 2. Enqueue job
         ▼
┌─────────────────┐
│  Redis Queue    │
│  (Bull)         │
└────────┬────────┘
         │
         │ 3. Process jobs
         ▼
┌─────────────────────────────────────┐
│  Workers (1-3 instances)            │
│  ┌───────────────────────────────┐ │
│  │ 1. Ticket Analyzer (OpenAI)   │ │
│  │ 2. Test Executor (Playwright) │ │
│  │ 3. Results Reporter (Jira)    │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
         │
         │ 4. Post results + screenshots
         ▼
┌─────────────────┐
│  Jira Comments  │
│  + Attachments  │
└─────────────────┘
```

## 📋 Requisitos

- Ubuntu 20.04+ (server o VM)
- Node.js 20.x
- Redis
- Credenciales de Jira Cloud (API Token)
- OpenAI API Key

## 🚀 Instalación

### 1. Clonar o copiar el proyecto

```bash
cd /opt
sudo git clone <repository> jira-qa-agent
cd jira-qa-agent
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Editar con tus credenciales:

```env
# Jira
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token-here

# OpenAI
OPENAI_API_KEY=sk-your-openai-key-here
OPENAI_MODEL=gpt-4-turbo-preview

# App URLs to test
APP_BASE_URL=https://your-app.com
APP_STAGING_URL=https://staging.your-app.com

# Optional: Test credentials if your app requires login
TEST_USER_EMAIL=test@example.com
TEST_USER_PASSWORD=test-password
```

### 3. Ejecutar deployment

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```

Este script:
- ✅ Instala Node.js, Redis, y dependencias de sistema
- ✅ Instala dependencias de npm
- ✅ Instala Playwright y navegadores
- ✅ Compila TypeScript
- ✅ Configura systemd services
- ✅ Inicia todos los servicios

## 🎮 Uso

### API Endpoints

#### 1. Test a Ticket

**POST** `/api/test-ticket`

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

O con URL:

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketUrl": "https://your-company.atlassian.net/browse/PROJ-123"}'
```

Response:

```json
{
  "success": true,
  "jobId": "123",
  "ticketId": "PROJ-123",
  "message": "Test job queued successfully",
  "status": "Check job status at /api/job-status/:jobId"
}
```

#### 2. Check Job Status

**GET** `/api/job-status/:jobId`

```bash
curl http://localhost:3000/api/job-status/123
```

Response:

```json
{
  "jobId": "123",
  "state": "completed",
  "progress": 100,
  "result": {
    "success": true,
    "ticketId": "PROJ-123",
    "summary": {
      "passed": true,
      "total": 3,
      "successful": 3,
      "failed": 0
    }
  }
}
```

#### 3. List Jobs

**GET** `/api/jobs?limit=20`

```bash
curl http://localhost:3000/api/jobs?limit=10
```

#### 4. Health Check

**GET** `/health`

```bash
curl http://localhost:3000/health
```

### Webhook Integration

Configura un webhook en Jira para auto-trigger tests:

1. Ve a **Jira Settings → System → Webhooks**
2. Create webhook:
   - **URL**: `http://your-server:3000/api/webhook/jira`
   - **Events**: Issue Updated
   - **JQL Filter**: `status = "Ready for QA"`

Ahora cuando un ticket se mueva a "Ready for QA", se ejecutarán tests automáticamente.

## 🛠️ Gestión de Servicios

### Ver status

```bash
./scripts/check-status.sh
```

### Reiniciar servicios

```bash
./scripts/restart-services.sh
```

### Ver logs en tiempo real

```bash
# Server logs
journalctl -u jira-qa-server -f

# Worker logs
journalctl -u jira-qa-worker@1 -f

# Todos los servicios
journalctl -u "jira-qa-*" -f
```

### Detener servicios

```bash
sudo systemctl stop jira-qa-server
sudo systemctl stop jira-qa-worker@{1..3}
```

### Iniciar servicios

```bash
sudo systemctl start jira-qa-server
sudo systemctl start jira-qa-worker@{1..3}
```

## 📸 Screenshots y Evidencia

Los screenshots se guardan en `/agent/screenshots/` organizados por ticket:

```
screenshots/
├── PROJ-123/
│   ├── scenario-1-step-1.png
│   ├── scenario-1-step-2.png
│   ├── scenario-1-step-3-ERROR.png
│   └── scenario-2-step-1.png
└── PROJ-124/
    └── ...
```

Estos screenshots se suben automáticamente a Jira como attachments.

## 🧪 Testing Manual

### Test API endpoint

```bash
./scripts/test-api.sh
```

### Test con ticket específico

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

## 🔧 Configuración Avanzada

### Ajustar workers concurrentes

Editar `/agent/.env`:

```env
MAX_CONCURRENT_TESTS=5  # Número de tests simultáneos por worker
```

Luego reiniciar:

```bash
sudo systemctl restart jira-qa-worker@{1..3}
```

### Añadir más workers

```bash
# Crear worker 4
sudo cp /etc/systemd/system/jira-qa-worker@1.service \
        /etc/systemd/system/jira-qa-worker@4.service

sudo systemctl daemon-reload
sudo systemctl enable jira-qa-worker@4
sudo systemctl start jira-qa-worker@4
```

### Configurar timeout de tests

En `.env`:

```env
BROWSER_TIMEOUT=60000  # 60 segundos
```

### Ejecutar tests en modo visible (no headless)

En `.env`:

```env
HEADLESS=false
```

Útil para debugging.

## 🐛 Troubleshooting

### Redis no conecta

```bash
sudo systemctl status redis-server
sudo systemctl restart redis-server
```

### Playwright browsers no instalados

```bash
cd /agent
npx playwright install chromium --with-deps
```

### Jira API errors (401/403)

Verificar credenciales en `.env`:
- Email correcto
- API Token válido (generar en https://id.atlassian.com/manage-profile/security/api-tokens)

### Worker se queda stuck

```bash
# Ver logs
journalctl -u jira-qa-worker@1 -n 50

# Reiniciar worker específico
sudo systemctl restart jira-qa-worker@1
```

### Limpiar queue de Redis

```bash
redis-cli
> FLUSHALL
```

## 📊 Monitoreo

### Ver queue stats

```bash
redis-cli
> KEYS bull:jira-qa-tests:*
> LLEN bull:jira-qa-tests:waiting
> LLEN bull:jira-qa-tests:active
> LLEN bull:jira-qa-tests:failed
```

### Ver uso de recursos

```bash
# CPU y memoria
htop

# Disco (screenshots pueden crecer)
df -h
du -sh /agent/screenshots/
```

### Limpiar screenshots antiguos

```bash
# Eliminar screenshots > 30 días
find /agent/screenshots/ -type f -mtime +30 -delete
```

## 🔒 Seguridad

### Firewall

Si expones el API públicamente:

```bash
sudo ufw allow 3000/tcp
sudo ufw enable
```

### Nginx reverse proxy con HTTPS

```bash
# Instalar certbot
sudo apt install certbot python3-certbot-nginx

# Obtener certificado
sudo certbot --nginx -d qa-agent.your-domain.com

# Nginx configurará HTTPS automáticamente
```

### Rate limiting

Añadir en `src/server.ts`:

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // max 100 requests por IP
});

app.use('/api/', limiter);
```

## 🎨 Personalización

### Modificar estrategia de análisis

Editar `src/agents/ticket-analyzer.ts` - función `buildAnalysisPrompt()`

### Añadir steps personalizados de Playwright

Editar `src/agents/test-executor.ts` - función `executeStep()`

### Cambiar formato de comentarios en Jira

Editar `src/clients/jira-client.ts` - función `postTestResults()`

## 📝 Logs

Los logs se guardan en:

- `/agent/logs/server.log` - Server logs
- `/agent/logs/worker-1.log` - Worker 1 logs
- `/agent/logs/worker-2.log` - Worker 2 logs
- `/agent/logs/worker-3.log` - Worker 3 logs
- `/agent/logs/error.log` - Todos los errors
- `/agent/logs/combined.log` - Todos los logs

Rotación automática configurada (14 días).

## 🤝 Contribuir

1. Fork el proyecto
2. Crea feature branch (`git checkout -b feature/amazing-feature`)
3. Commit cambios (`git commit -m 'Add amazing feature'`)
4. Push al branch (`git push origin feature/amazing-feature`)
5. Abre Pull Request

## 📄 Licencia

MIT License - ver LICENSE file

## 🆘 Soporte

Para issues o preguntas:
- Abrir issue en GitHub
- Email: support@your-company.com

## 🔌 Integración MCP (Model Context Protocol)

El sistema soporta MCP para una integración más robusta con Jira:

### Ventajas de MCP
- ✅ Abstracción de la API de Jira
- ✅ Reutilizable en múltiples proyectos
- ✅ Fallback automático a API directa
- ✅ Más fácil de mantener y versionar

### Setup Rápido

```bash
# Instalar y configurar MCP
./scripts/setup-mcp.sh

# Configurar credenciales
nano mcp-server-jira/.env

# Reiniciar servicios
./scripts/restart-services.sh
```

Ver [MCP_INTEGRATION.md](MCP_INTEGRATION.md) para detalles completos.

## 🎯 Roadmap

- [x] Integración MCP con Jira
- [ ] Soporte para tests API (REST)
- [ ] Integración con más issue trackers (GitHub, Linear)
- [ ] Dashboard web para monitoreo
- [ ] Tests de performance con Lighthouse
- [ ] Tests de accesibilidad (a11y)
- [ ] Integración con Slack/Discord notifications
- [ ] Soporte para tests móviles (Android/iOS)
- [ ] AI-powered test generation improvements

---

**Hecho con ❤️ para equipos de QA**
