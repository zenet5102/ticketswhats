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
