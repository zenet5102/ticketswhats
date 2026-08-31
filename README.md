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

## Tercer server de migracion

El tercer server permite migrar y probar datos en MySQL sin reemplazar el server principal ni el segundo server.

Levantar en desarrollo:

```bash
npm run dev:third
```

Levantar directo con Node:

```bash
npm run start:third
```

Por defecto escucha en `THIRD_APP_PORT=3002`.

Endpoints principales:

```text
GET /login
POST /auth/login
POST /auth/logout
GET /auth/me
GET /dashboard
GET /mensajes
GET /cola
GET /whatsapp
GET /usuarios
GET /phantom/suspendidos
GET /phantom/activos
GET /phantom/clientes
GET /phantom/baja
GET /api/third/status
GET /api/third/counts
GET /api/third/users
GET /api/third/tickets
GET /api/third/messages
GET /api/third/audit/messages
POST /api/third/audit/messages
```

El login del tercer server usa la tabla `users` migrada a MySQL. Las paginas leen datos desde MySQL. La pantalla `/whatsapp` muestra las sesiones como entorno de migracion y guarda los nombres de sesion en `app_state` de MySQL, sin iniciar clientes reales de WhatsApp desde el tercer server.

Las APIs aceptan sesion web o API key. Si `THIRD_APP_API_KEYS` esta configurado, enviar la clave asi:

```http
Authorization: Bearer clave
```

o:

```http
X-Third-Api-Key: clave
```

Migrar datos actuales desde SQLite al MySQL del tercer server:

```bash
npm run migrate:third
```

Variables relevantes:

```env
THIRD_APP_PORT=3002
THIRD_APP_API_KEYS=
THIRD_APP_AUTH_COOKIE_NAME=wwebjs_third_session
THIRD_APP_AUTH_SESSION_HOURS=12
THIRD_APP_AUTH_SESSION_SECRET=
THIRD_APP_MYSQL_HOST=127.0.0.1
THIRD_APP_MYSQL_PORT=3306
THIRD_APP_MYSQL_USER=root
THIRD_APP_MYSQL_PASSWORD=
THIRD_APP_MYSQL_DATABASE=wwebjs_third
THIRD_APP_SQLITE_SOURCE=./data/tickets.sqlite
```
