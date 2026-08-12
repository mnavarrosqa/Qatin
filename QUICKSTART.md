# Quick Start Guide 🚀

Guía rápida para poner en marcha el Jira QA Agent en 5 minutos.

## Opción rápida (local / Mac)

```bash
npm install
npm run setup          # interactivo: Playwright, MCP, plugins (con explicación)
npm start              # terminal 1
npm run worker         # terminal 2
```

Abrí http://localhost:8545

---

## Opción 1: Ubuntu Server (producción)

```bash
git clone <repository> qatin
cd qatin
cp .env.example .env
# Completá LLM keys (Jira opcional). CREDENTIALS_SECRET lo puede generar deploy.sh.

chmod +x deploy.sh scripts/*.sh
./scripts/pre-deploy-check.sh
sudo ./deploy.sh

curl http://127.0.0.1:8545/health
npx pm2 status
```

Detalle: [DEPLOY_INSTRUCTIONS.md](./DEPLOY_INSTRUCTIONS.md).

---

## Opción 2: Docker (Desarrollo local)

### Paso 1: Requisitos

- Docker
- Docker Compose

### Paso 2: Configurar

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

### Paso 3: Iniciar

```bash
docker-compose up -d
```

### Paso 4: Ver logs

```bash
docker-compose logs -f
```

### Paso 5: Probar

```bash
curl http://localhost:8545/health
```

---

## Configurar Webhook en Jira (Opcional pero recomendado)

1. Ve a **Jira → Settings → System → Webhooks**
2. Clic en **Create a WebHook**
3. Configurar:
   - **Name**: QA Agent Auto-Test
   - **Status**: Enabled
   - **URL**: `http://YOUR-SERVER-IP:8545/api/webhook/jira`
   - **Events**: Issue → updated
   - **JQL**: `status = "Ready for QA"`
4. Save

Ahora los tests se ejecutan automáticamente cuando un ticket pase a "Ready for QA".

---

## Uso Básico

### Testear un ticket manualmente

```bash
curl -X POST http://localhost:8545/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

### Ver estado del job

```bash
# Respuesta del comando anterior incluye jobId
curl http://localhost:8545/api/job-status/JOB-ID
```

### Ver todos los jobs

```bash
curl http://localhost:8545/api/jobs | jq .
```

---

## Troubleshooting Rápido

### "Connection refused"

```bash
# Ver si el servicio está corriendo
sudo systemctl status jira-qa-server

# Reiniciar
sudo systemctl restart jira-qa-server
```

### "Jira authentication failed"

Verificar en `.env`:
- Email correcto
- API Token válido y copiado completo
- JIRA_URL sin / al final

### "OpenAI error"

Verificar:
- API Key válida
- Saldo disponible en cuenta OpenAI

### Ver logs

```bash
# Logs del servidor
tail -f /opt/jira-qa-agent/logs/server.log

# Logs de workers
tail -f /opt/jira-qa-agent/logs/worker-1.log
```

---

## Scripts Útiles

### Ver estado de todo

```bash
./scripts/check-status.sh
```

### Reiniciar servicios

```bash
./scripts/restart-services.sh
```

### Test interactivo

```bash
./scripts/test-api.sh
```

---

## Próximos Pasos

1. ✅ Configurar webhook para auto-testing
2. ✅ Personalizar `APP_BASE_URL` en `.env`
3. ✅ Añadir credenciales de test si tu app requiere login
4. ✅ Testear con tickets reales
5. ✅ Monitorear logs y ajustar según necesidad

---

## Soporte

- 📖 Ver [README.md](README.md) para documentación completa
- 🐛 Issues en GitHub
- 💬 Email: support@company.com

¡Disfruta del testing automatizado! 🎉
