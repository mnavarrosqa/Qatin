# Arquitectura del Sistema

Documentación técnica detallada de la arquitectura del Jira QA Agent.

## Visión General

El sistema está diseñado con una arquitectura de microservicios orientada a eventos, utilizando un patrón Producer-Consumer con Redis como mensaje queue.

```
┌──────────────────────────────────────────────────────────────┐
│                        JIRA CLOUD API                         │
└────────────────────┬────────────────────────┬─────────────────┘
                     │                        │
                     │ Fetch Ticket           │ Post Results
                     ▼                        ▲
┌─────────────────────────────────────────────────────────────┐
│                      API SERVER (Express)                    │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Routes:                                               │ │
│  │  - POST /api/test-ticket    (trigger test)            │ │
│  │  - GET  /api/job-status/:id (check progress)          │ │
│  │  - GET  /api/jobs           (list all jobs)           │ │
│  │  - POST /api/webhook/jira   (auto-trigger)            │ │
│  │  - GET  /health             (health check)            │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Enqueue Job
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    REDIS (Bull Queue)                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Queues:                                               │ │
│  │  - jira-qa-tests:waiting                              │ │
│  │  - jira-qa-tests:active                               │ │
│  │  - jira-qa-tests:completed                            │ │
│  │  - jira-qa-tests:failed                               │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Consume Jobs (1-N workers)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   WORKER PROCESSES (N=3)                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  1. TICKET ANALYZER                                 │   │
│  │     ┌──────────────────────────────────────────┐   │   │
│  │     │  - Fetch ticket from Jira                │   │   │
│  │     │  - Extract description & AC              │   │   │
│  │     │  - Call OpenAI GPT-4                     │   │   │
│  │     │  - Generate test strategy                │   │   │
│  │     │  - Parse into structured scenarios       │   │   │
│  │     └──────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  2. TEST EXECUTOR (Playwright)                      │   │
│  │     ┌──────────────────────────────────────────┐   │   │
│  │     │  For each scenario:                      │   │   │
│  │     │    - Launch browser (Chromium)           │   │   │
│  │     │    - Execute steps sequentially          │   │   │
│  │     │    - Capture screenshots                 │   │   │
│  │     │    - Handle errors gracefully            │   │   │
│  │     │    - Collect console logs                │   │   │
│  │     │    - Generate execution report           │   │   │
│  │     └──────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  3. RESULTS REPORTER                                │   │
│  │     ┌──────────────────────────────────────────┐   │   │
│  │     │  - Format results (ADF)                  │   │   │
│  │     │  - Upload screenshots to Jira            │   │   │
│  │     │  - Post comment with results             │   │   │
│  │     │  - Add labels (qa-passed/qa-failed)      │   │   │
│  │     │  - Transition issue (optional)           │   │   │
│  │     └──────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      FILE SYSTEM                             │
│  /agent/                                                     │
│  ├── screenshots/                                            │
│  │   ├── PROJ-123/                                          │
│  │   │   ├── scenario-1-step-1.png                          │
│  │   │   └── scenario-1-step-2.png                          │
│  │   └── PROJ-124/                                          │
│  └── logs/                                                   │
│      ├── server.log                                          │
│      ├── worker-1.log                                        │
│      └── error.log                                           │
└─────────────────────────────────────────────────────────────┘
```

## Componentes Principales

### 1. API Server (`src/server.ts`)

**Responsabilidades:**
- Exponer API REST para triggering de tests
- Validar requests
- Encolar jobs en Redis
- Manejar webhooks de Jira
- Proporcionar endpoints de status

**Stack:**
- Express.js
- Zod (validación)
- CORS

**Endpoints:**

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/test-ticket` | Encola test de un ticket |
| GET | `/api/job-status/:id` | Status de un job específico |
| GET | `/api/jobs` | Lista todos los jobs |
| POST | `/api/webhook/jira` | Webhook para auto-trigger |
| GET | `/health` | Health check |

### 2. Queue System (`src/queue.ts`)

**Responsabilidades:**
- Gestionar cola de jobs con Bull
- Retry logic (3 intentos con backoff exponencial)
- Mantener histórico de jobs (últimos 100 completed, 50 failed)
- Event handling (active, completed, failed)

**Configuración:**
```typescript
{
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000 // 2s, 4s, 8s
  },
  removeOnComplete: 100,
  removeOnFail: 50
}
```

### 3. Worker Process (`src/worker.ts`)

**Responsabilidades:**
- Procesar jobs de la cola
- Coordinar el flujo: Analyze → Execute → Report
- Manejar errores y reintentos
- Actualizar progreso del job (10%, 30%, 50%, 80%, 100%)

**Concurrencia:**
- 3 workers por defecto
- Cada worker puede procesar hasta `MAX_CONCURRENT_TESTS` jobs simultáneamente (default: 3)
- Total: hasta 9 tests en paralelo

### 4. Ticket Analyzer (`src/agents/ticket-analyzer.ts`)

**Responsabilidades:**
- Extraer información del ticket de Jira
- Identificar acceptance criteria
- Llamar a OpenAI GPT-4 para análisis
- Generar estrategia de testing estructurada

**Input:**
```typescript
{
  key: "PROJ-123",
  fields: {
    summary: "Add login form",
    description: "...",
    issuetype: { name: "Story" },
    priority: { name: "High" }
  }
}
```

**Output:**
```typescript
{
  testType: "ui",
  summary: "Test login functionality",
  scenarios: [
    {
      id: "scenario-1",
      description: "Test valid login",
      steps: ["Navigate to /login", "Fill email", ...],
      expectedResults: ["User logged in", ...],
      urls: ["/login", "/dashboard"],
      selectors: ["input[type='email']", ...]
    }
  ]
}
```

**IA Prompt:**
- System: Expert QA engineer
- User: Ticket details + instructions
- Response format: JSON structured

### 5. Test Executor (`src/agents/test-executor.ts`)

**Responsabilidades:**
- Ejecutar escenarios con Playwright
- Gestionar lifecycle del browser
- Capturar screenshots en cada paso
- Manejar errores y timeouts
- Generar reportes detallados

**Browser Configuration:**
```typescript
{
  headless: true, // false para debugging
  viewport: { width: 1920, height: 1080 },
  timeout: 30000 // 30s per action
}
```

**Step Execution:**
- Parsing inteligente de instrucciones en lenguaje natural
- Extracción de selectores CSS
- Fallback a text selectors
- Screenshots after each step
- Error screenshots con anotaciones

**Acciones Soportadas:**
- Navigate (goto URL)
- Click (botones, links)
- Fill/Type (inputs)
- Wait (timeout o selector)
- Check/Verify (assertions)
- Scroll
- Hover
- Select (dropdowns)

### 6. Jira Client (`src/clients/jira-client.ts`)

**Responsabilidades:**
- Autenticación con Jira API (Basic Auth)
- Fetch de tickets
- Creación de comentarios (Atlassian Document Format)
- Upload de attachments (screenshots)
- Transiciones de issues
- Gestión de labels

**Formato de Comentarios:**

Usa ADF (Atlassian Document Format) para rich formatting:
- Paneles (success/error)
- Headings
- Code blocks
- Bullet lists
- Bold/italic text

**Screenshot Upload:**
- Form-data multipart
- PNG format
- Header: `X-Atlassian-Token: no-check`

## Flujo de Datos Completo

### 1. Request Inicial

```
User/Webhook → POST /api/test-ticket
                 ↓
              Validation
                 ↓
              Enqueue Job
                 ↓
              Return { jobId: "123" }
```

### 2. Job Processing

```
Worker picks job from queue
        ↓
Progress: 10%
        ↓
Fetch ticket from Jira
        ↓
Progress: 30%
        ↓
Analyze with OpenAI
        ↓
Generate test strategy
        ↓
Progress: 50%
        ↓
Launch Playwright browser
        ↓
For each scenario:
  - Execute steps
  - Capture screenshots
  - Handle errors
        ↓
Progress: 80%
        ↓
Compile results
        ↓
Upload screenshots to Jira
        ↓
Post comment with results
        ↓
Add labels
        ↓
Transition issue (optional)
        ↓
Progress: 100%
        ↓
Job completed
```

### 3. Error Handling

```
Error occurs
    ↓
Log error
    ↓
Capture error screenshot
    ↓
Retry (if attempts < 3)
    ↓
If all retries fail:
  - Post error comment to Jira
  - Add "qa-error" label
  - Mark job as failed
```

## Escalabilidad

### Horizontal Scaling

**Workers:**
```bash
# Añadir más workers
sudo systemctl enable jira-qa-worker@4
sudo systemctl start jira-qa-worker@4
```

**Concurrencia por Worker:**
```env
MAX_CONCURRENT_TESTS=5  # Más tests simultáneos
```

**Redis:**
- Usar Redis Cluster para alta disponibilidad
- Redis Sentinel para failover automático

### Vertical Scaling

**Recursos por Worker:**
- CPU: 2+ cores (Playwright es CPU-intensivo)
- RAM: 2GB+ por worker (browsers consumen memoria)
- Disk: SSD recomendado (screenshots I/O)

**Optimizaciones:**
- Reutilizar browser contexts
- Lazy loading de Playwright
- Comprimir screenshots
- Limpiar screenshots antiguos

## Seguridad

### Secrets Management

**Variables de entorno:**
- Nunca commitear `.env`
- Usar secrets managers en producción (Vault, AWS Secrets Manager)

**Jira API Token:**
- Scope limitado
- Rotación regular
- Monitorear uso

**OpenAI API Key:**
- Limitar rate
- Monitorear costos
- Usar fallback si falla

### Network Security

**Firewall:**
```bash
# Solo exponer API si necesario
ufw allow 3000/tcp
```

**Reverse Proxy:**
```nginx
# Nginx con rate limiting
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/m;

location /api/ {
    limit_req zone=api burst=5;
    proxy_pass http://localhost:3000;
}
```

**HTTPS:**
```bash
# Let's Encrypt
certbot --nginx -d qa-agent.domain.com
```

## Monitoreo y Observabilidad

### Logs

**Structured Logging (Winston):**
```typescript
logger.info('Job started', { 
  jobId, 
  ticketId, 
  timestamp 
});
```

**Log Levels:**
- error: Errores críticos
- warn: Warnings
- info: Información general
- debug: Debugging detallado

**Log Aggregation:**
- Centralizar con ELK Stack (Elasticsearch, Logstash, Kibana)
- O usar Grafana Loki

### Métricas

**Redis Metrics:**
```bash
redis-cli INFO stats
> total_commands_processed
> instantaneous_ops_per_sec
```

**Job Metrics:**
- Total jobs processed
- Success rate
- Average execution time
- Queue depth

**System Metrics:**
- CPU usage
- Memory usage
- Disk I/O
- Network traffic

### Alerting

**Condiciones de alerta:**
- Workers down
- Queue depth > threshold
- Error rate > 10%
- Disk space < 20%
- Response time > 60s

**Herramientas:**
- Prometheus + AlertManager
- Grafana
- PagerDuty

## Roadmap Técnico

### Fase 1 (Actual)
- ✅ Core functionality
- ✅ Jira integration
- ✅ Playwright tests
- ✅ Screenshot capture

### Fase 2 (Próxima)
- [ ] Dashboard web (React)
- [ ] Metrics & monitoring
- [ ] API tests support
- [ ] Multiple browser support

### Fase 3 (Futuro)
- [ ] Kubernetes deployment
- [ ] GraphQL API
- [ ] Real-time updates (WebSocket)
- [ ] Test recording (user flows)
- [ ] AI test generation improvements

---

**Última actualización:** 2024-01-15
