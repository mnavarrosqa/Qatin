# Ejemplo de Ticket de Jira

Este es un ejemplo de cómo debería verse un ticket de Jira para que el agente pueda generar tests efectivos.

## Ticket Example: USER-123

### Tipo
Story / Feature / Bug

### Resumen
Add user registration form with email validation

### Descripción

```
As a new user
I want to register for an account using my email
So that I can access the platform

The registration form should:
- Accept email and password
- Validate email format
- Show error messages for invalid inputs
- Redirect to dashboard after successful registration
- Send confirmation email
```

### Acceptance Criteria

```
AC1: Email validation
- Given I'm on the registration page
- When I enter an invalid email format
- Then I should see "Invalid email format" error

AC2: Password requirements
- Given I'm on the registration page  
- When I enter a password shorter than 8 characters
- Then I should see "Password must be at least 8 characters" error

AC3: Successful registration
- Given I enter valid email and password
- When I click "Register"
- Then I should be redirected to /dashboard
- And I should see "Welcome!" message

AC4: Duplicate email
- Given an account already exists with email@example.com
- When I try to register with the same email
- Then I should see "Email already registered" error
```

### Labels
- `frontend`
- `registration`
- `authentication`

---

## Lo que el Agente QA hará

Con un ticket así, el agente:

1. **Analizará** los acceptance criteria usando IA
2. **Generará** escenarios de test como:
   - Navegación a `/register`
   - Test de validación de email inválido
   - Test de password corto
   - Test de registro exitoso
   - Test de email duplicado
3. **Ejecutará** cada escenario con Playwright
4. **Capturará** screenshots de cada paso
5. **Reportará** resultados en comentario de Jira con evidencia

---

## Consejos para Tickets Óptimos

### ✅ Buenos tickets para auto-testing

- Tienen acceptance criteria claros
- Incluyen URLs específicas
- Describen flujos de usuario
- Mencionan elementos UI (buttons, forms, etc.)
- Definen comportamientos esperados

### ❌ Tickets difíciles para auto-testing

- Muy abstractos o vagos
- Sin acceptance criteria
- Cambios solo de backend sin UI
- Requieren configuración manual compleja

---

## Ejemplos de Diferentes Tipos

### Bug Report

```
Ticket: BUG-456
Summary: Cart total calculation incorrect

Description:
When adding multiple items to cart, the total price shows wrong value.

Steps to reproduce:
1. Go to /products
2. Add "Product A" ($10) to cart
3. Add "Product B" ($20) to cart
4. Go to /cart

Expected: Total should be $30
Actual: Total shows $50

Environment: Production
Browser: Chrome 120
```

### Feature

```
Ticket: FEAT-789
Summary: Add dark mode toggle

Description:
Implement dark mode toggle in user settings.

Requirements:
- Toggle switch in /settings
- Persist preference in localStorage
- Apply dark theme immediately
- All pages should support dark mode

Acceptance Criteria:
- Given I'm in settings
- When I toggle dark mode ON
- Then background should change to dark (#1a1a1a)
- And text should change to light (#ffffff)
- And preference is saved
```

---

## Integración con el Agente

### Comando manual
```bash
curl -X POST http://your-server:3000/api/test-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticketId": "USER-123"}'
```

### Webhook automático
Cuando ticket se mueve a "Ready for QA", el agente:
1. Lee el ticket
2. Genera tests
3. Ejecuta tests
4. Postea resultados

### Comentario resultante en Jira

```
✅ Automated QA Test Results

Status: ✅ PASSED
Test Summary: 4/4 tests passed
Execution Time: 12.5s
Timestamp: 2024-01-15T10:30:00Z

TEST EXECUTION REPORT
============================================================

Summary: Testing user registration flow with validation
Test Type: ui
Total Scenarios: 4
Passed: 4
Failed: 0
Total Duration: 12.50s

SCENARIO DETAILS
------------------------------------------------------------

[scenario-1] ✅ PASSED
Description: Test email validation
Duration: 2.34s

Steps:
  1. [✓] Navigate to {{BASE_URL}}/register
     Screenshot: scenario-1-step-1.png
  2. [✓] Fill email field with invalid-email
     Screenshot: scenario-1-step-2.png
  3. [✓] Click submit button
     Screenshot: scenario-1-step-3.png
  4. [✓] Verify error message "Invalid email format"
     Screenshot: scenario-1-step-4.png

------------------------------------------------------------
... (más escenarios)

📸 Test Evidence - Screenshots:
• scenario-1-step-1.png
• scenario-1-step-2.png
• scenario-1-step-3.png
• scenario-1-step-4.png

💡 Check attachments above for detailed screenshots
```
