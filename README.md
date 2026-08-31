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

En la VM, despues de traer cambios:

```bash
git pull --ff-only origin codex/unificar-servers
npm run migrate:second-messages
pm2 restart wwebjs --update-env
pm2 save
```
