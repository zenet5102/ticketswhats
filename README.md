# ticketswhats

## Produccion con PM2

En produccion no levantar el segundo server con `npm run dev:second`, porque usa `nodemon` y puede reiniciar cuando cambian archivos de sesion de WhatsApp.

Usar:

```bash
npm run pm2:start
pm2 save
```

Para aplicar cambios:

```bash
npm run pm2:restart
pm2 save
```

## API de auditoria de mensajes

El server principal expone una API para que otra aplicacion consulte mensajes de WhatsApp por telefono, cliente o ticket.

## Recuperacion de mensajes al reconectar WhatsApp

El server principal mantiene un sync liviano de mensajes recientes mientras las sesiones estan conectadas. Si una sesion de WhatsApp se desconecta por un rato, al volver a `CONNECTED` dispara automaticamente una recuperacion mas amplia para esa cuenta.

Variables relevantes:

```env
WHATSAPP_STATUS_POLL_INTERVAL_MS=30000
WHATSAPP_RECENT_MESSAGES_SYNC_INTERVAL_MS=120000
WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_COOLDOWN_MS=12000
WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_LIMIT=35
WHATSAPP_RECENT_MESSAGES_SYNC_MESSAGE_LIMIT=12
WHATSAPP_CATCHUP_ON_RECONNECT=true
WHATSAPP_CATCHUP_DELAY_MS=3000
WHATSAPP_CATCHUP_CHAT_LIMIT=120
WHATSAPP_CATCHUP_MESSAGE_LIMIT=50
WHATSAPP_TRANSIENT_RESTART_COOLDOWN_MS=120000
WHATSAPP_CLIENT_INIT_DELAY_MS=5000
WHATSAPP_CLIENT_INIT_STAGGER_MS=30000
STARTUP_BACKGROUND_JOBS_DELAY_MS=30000
```

El catch-up recorre los chats mas recientes de la cuenta reconectada y guarda los ultimos mensajes de cada chat en `whatsapp_messages`. La operacion es idempotente: si un mensaje ya existe, se actualiza sin duplicarlo. Para cortes mas largos, subir temporalmente `WHATSAPP_CATCHUP_CHAT_LIMIT` y `WHATSAPP_CATCHUP_MESSAGE_LIMIT`, reiniciar PM2 con `--update-env` y esperar a que la cuenta vuelva a conectar.

Tambien se puede forzar manualmente con un usuario admin autenticado:

```bash
curl -X POST "http://localhost:3000/messages/recover" \
  -H "Content-Type: application/json" \
  -d "{\"accountId\":\"bot-1\",\"chatLimit\":120,\"messageLimit\":50}"
```

Sin `accountId`, intenta recuperar todas las sesiones conectadas.

## Reglas de conversaciones

La pantalla de conversaciones usa estas reglas:

- Primero se traen los chats de las sesiones WhatsApp asignadas al usuario. Si tiene `bot-1` y `bot-2`, se traen ambas. Si tiene una sola, solo esa.
- Los chats se ordenan siempre por ultimo mensaje descendente dentro de cada solapa.
- Admin ve todos los chats permitidos en Principal.
- Un usuario con cuadrillas/grupos ve en Principal los chats cuyo telefono pertenece a tickets visibles de sus cuadrillas. El resto queda en Otros.
- Un usuario sin cuadrillas/grupos ve en Principal solo los chats que inicio el mismo usuario. El resto queda en Otros.
- Las conversaciones movidas manualmente a Principal u Otros respetan esa solapa, pero mantienen orden descendente con el resto.

Endpoint:

```text
GET /api/audit/messages
POST /api/audit/messages
```

La API consulta por defecto la base unificada del server principal. El historial viejo del segundo numero se importa desde MySQL con `npm run migrate:second-messages` y queda guardado en `whatsapp_messages` con `whatsapp_account=bot-2`.

### Autenticacion

Configurar una o mas claves en `.env`:

```env
AUDIT_API_KEYS=clave-uno,clave-dos
```

La aplicacion externa puede enviar la clave de cualquiera de estas dos formas:

```http
Authorization: Bearer clave-uno
```

```http
X-Audit-Api-Key: clave-uno
```

Si `AUDIT_API_KEYS` no esta configurado, el endpoint queda protegido por login/admin local.

### Parametros

Se puede buscar usando cualquiera de estos filtros:

- `phone` o `telefono`: numero de telefono.
- `ticket`, `ticketId` o `externalId`: identificador del ticket.
- `clientId`, `ida` o `IDA`: ID del cliente Phantom.
- `client`, `cliente` o `razonSocial`: nombre o razon social del cliente.

Parametros opcionales:

- `limit`: cantidad maxima de mensajes, hasta 1000. Por defecto 200.
- `source`: `primary`, `sqlite`, `all`, `second` o `mysql`. Por defecto `primary`. `second`/`mysql` queda como respaldo temporal para consultar la base vieja del segundo server.
- `accountId` o `whatsappAccount`: filtra por cuenta WhatsApp, por ejemplo `bot-1` o `bot-2`.
- `from`, `fromDate` o `since`: fecha/hora inicial.
- `to`, `toDate` o `until`: fecha/hora final.
- `includeMedia`: `true` o `1` para incluir `media.data`.

### Ejemplos

Buscar por telefono:

```bash
curl "http://localhost:3000/api/audit/messages?phone=5491111111111&limit=100" \
  -H "Authorization: Bearer clave-uno"
```

Buscar por ticket:

```bash
curl "http://localhost:3000/api/audit/messages?ticket=12345" \
  -H "Authorization: Bearer clave-uno"
```

Buscar por cliente/IDA:

```bash
curl "http://localhost:3000/api/audit/messages?clientId=98765" \
  -H "Authorization: Bearer clave-uno"
```

Usar POST con JSON:

```bash
curl -X POST "http://localhost:3000/api/audit/messages" \
  -H "Authorization: Bearer clave-uno" \
  -H "Content-Type: application/json" \
  -d "{\"ticket\":\"12345\",\"limit\":100}"
```

### Respuesta

La respuesta tiene esta forma general:

```json
{
  "success": true,
  "query": {
    "phone": "5491111111111",
    "ticket": "",
    "clientId": "",
    "client": "",
    "source": "all",
    "accountId": "",
    "limit": 100
  },
  "resolved": {
    "phones": ["5491111111111"],
    "tickets": [],
    "clients": []
  },
  "count": 1,
  "warnings": [],
  "messages": [
    {
      "store": "primary-sqlite",
      "id": "mensaje-id",
      "accountId": "bot-1",
      "chatId": "5491111111111@c.us",
      "phone": "5491111111111",
      "contactName": "Cliente",
      "direction": "outgoing",
      "body": "Texto del mensaje",
      "timestampTs": 1710000000000,
      "timestampIso": "2024-03-09T16:00:00.000Z",
      "fromMe": true,
      "source": "ticket",
      "media": {
        "hasMedia": false,
        "mime": "",
        "filename": ""
      }
    }
  ]
}
```

`warnings` puede incluir avisos si MySQL/Phantom no esta disponible. En uso normal, los mensajes deberian estar ya migrados en la base principal.

## Migrar mensajes del segundo server

Para que el server unificado trabaje con una sola tabla de mensajes, importar el historial del segundo server:

```bash
npm run migrate:second-messages
```

La migracion lee `SECOND_APP_MYSQL_DATABASE` / `SECOND_APP_MYSQL_MESSAGES_TABLE` y escribe en la tabla principal `whatsapp_messages` con `whatsapp_account=bot-2`. Se puede ejecutar mas de una vez: usa los IDs existentes y, si detecta una colision con mensajes del primer numero, guarda el mensaje con prefijo `bot-2:`.

Si la rama esta migrada a MySQL, primero copiar la base SQLite legacy a MySQL:

```bash
npm run migrate:sqlite-to-mysql
```

Despues importar el historial viejo del segundo numero:

```bash
git pull --ff-only origin codex/unificar-servers
npm run migrate:sqlite-to-mysql
npm run migrate:second-messages
pm2 restart wwebjs --update-env
pm2 save
```
