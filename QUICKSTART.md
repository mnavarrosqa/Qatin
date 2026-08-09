# Quick Start Guide 🚀

Guía rápida para poner en marcha el Jira QA Agent en 5 minutos.

## Opción 1: Ubuntu Server (Recomendado para producción)

### Paso 1: Preparar servidor

```bash
# Conectarse al servidor
ssh user@your-server

# Ir a directorio de instalación
cd /opt
```

### Paso 2: Clonar proyecto

```bash
sudo git clone <repository> jira-qa-agent
cd jira-qa-agent
sudo chown -R $USER:$USER .
```

### Paso 3: Configurar credenciales

```bash
cp .env.example .env
nano .env
```

Completar:
- `JIRA_URL` - Tu URL de Jira Cloud
- `JIRA_EMAIL` - Tu email
- `JIRA_API_TOKEN` - Token de https://id.atlassian.com/manage-profile/security/api-tokens
- `OPENAI_API_KEY` - Tu API key de OpenAI
- `APP_BASE_URL` - URL de tu aplicación a testear

### Paso 4: Deploy

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```

Esperar 5-10 minutos mientras instala todo.

### Paso 5: Verificar

```bash
curl http://localhost:3000/health
```

Deberías ver: `{"status":"ok",...}`

### Paso 6: Probar

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "TU-TICKET-123"}'
```

¡Listo! El agente comenzará a testear.

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
curl http://localhost:3000/health
```

---

## Configurar Webhook en Jira (Opcional pero recomendado)

1. Ve a **Jira → Settings → System → Webhooks**
2. Clic en **Create a WebHook**
3. Configurar:
   - **Name**: QA Agent Auto-Test
   - **Status**: Enabled
   - **URL**: `http://YOUR-SERVER-IP:3000/api/webhook/jira`
   - **Events**: Issue → updated
   - **JQL**: `status = "Ready for QA"`
4. Save

Ahora los tests se ejecutan automáticamente cuando un ticket pase a "Ready for QA".

---

## Uso Básico

### Testear un ticket manualmente

```bash
curl -X POST http://localhost:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "PROJ-123"}'
```

### Ver estado del job

```bash
# Respuesta del comando anterior incluye jobId
curl http://localhost:3000/api/job-status/JOB-ID
```

### Ver todos los jobs

```bash
curl http://localhost:3000/api/jobs | jq .
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
