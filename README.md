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
## API externa de auditoria

El primer server expone una API para consultar mensajes desde otra aplicacion sin usar la sesion web. Esta API solo funciona con token configurado en `.env`:

```env
AUDIT_API_KEYS=token-largo-uno,token-largo-dos
```

Endpoint:

```text
GET /api/audit/messages
POST /api/audit/messages
GET /api/audit/messages/by-agent
GET /api/audit/chats/by-agent
```

Autenticacion:

```http
Authorization: Bearer token-largo-uno
```

Tambien acepta:

```http
X-Audit-Api-Key: token-largo-uno
```

Filtros soportados:

- `phone` o `telefono`: numero del cliente.
- `ticket`, `ticketId` o `externalId`: ID del ticket.
- `IDA`, `ida` o `clientId`: ID del cliente Phantom. Si viene con ceros adelante, por ejemplo `008831`, se busca como `8831`.
- `client`, `cliente` o `razonSocial`: nombre o razon social.
- `accountId` o `whatsappAccount`: `bot-1` o `bot-2`.
- `source`: `all`, `primary`, `sqlite`, `second` o `mysql`. Por defecto `all`.
- `from` / `since` y `to` / `until`: rango de fechas.
- `limit`: maximo 1000, por defecto 200.

La respuesta no incluye `media_data`; solo informa si hay adjunto y su metadata.

Ejemplos:

```bash
curl "http://localhost:3000/api/audit/messages?phone=5491111111111&limit=100" \
  -H "Authorization: Bearer token-largo-uno"
```

```bash
curl "http://localhost:3000/api/audit/messages?ticket=12345" \
  -H "Authorization: Bearer token-largo-uno"
```

```bash
curl "http://localhost:3000/api/audit/messages?IDA=98765&source=all" \
  -H "Authorization: Bearer token-largo-uno"
```

```bash
curl -X POST "http://localhost:3000/api/audit/messages" \
  -H "Authorization: Bearer token-largo-uno" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"5491111111111\",\"accountId\":\"bot-2\",\"limit\":50}"
```

Mensajes enviados por agente:

```bash
curl "http://localhost:3000/api/audit/messages/by-agent?agent=operador1&source=all&limit=100" \
  -H "Authorization: Bearer token-largo-uno"
```

Chats donde intervino un agente:

```bash
curl "http://localhost:3000/api/audit/chats/by-agent?agent=operador1&accountId=bot-2&limit=50" \
  -H "Authorization: Bearer token-largo-uno"
```
