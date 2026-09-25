# Facturación Telefonía

Aplicación interna de RED PRIMER CORP, S.L. para sincronizar servicios de Nexlink, configurar tarifas propias, revisar facturas y emitirlas únicamente después de una confirmación explícita.

## Controles incluidos

- PostgreSQL como fuente transaccional y migración automática al arrancar.
- Separación entre precios de referencia de Nexlink y tarifas facturables propias.
- Bloqueo de periodos duplicados por cliente.
- Validación de NIF/CIF, dirección, email, IVA, vencimiento, serie y tarifa por línea.
- Cálculos monetarios en céntimos con precisión decimal.
- Reserva correlativa de número dentro de una transacción con bloqueo.
- PDF A4 almacenado en PostgreSQL y hash SHA-256 para comprobar integridad.
- Registro en Notion y envío mediante Gmail solo al escribir `EMITIR Y ENVIAR`.
- Si Gmail falla, conserva el número y marca `Error de envío`.
- Acceso protegido con autenticación HTTP Basic.

El campo `currentConsumption` de Nexlink no tiene unidad ni periodo documentados. La aplicación lo conserva como dato de origen, pero no factura exceso de GB automáticamente hasta que se verifique su significado o se incorpore un endpoint de consumo de datos documentado.

## Desarrollo local

Requisitos: Node.js 22 o superior y PostgreSQL.

```bash
cp .env.example .env
npm install
npm run dev
```

La aplicación crea sus tablas al arrancar. Abre `http://localhost:3000` e introduce `ADMIN_USERNAME` y `ADMIN_PASSWORD`.

## Despliegue en Railway

1. Crea un repositorio GitHub con este proyecto y conéctalo al proyecto de Railway.
2. Añade un servicio PostgreSQL y referencia su `DATABASE_URL` desde el servicio de la aplicación.
3. Configura las variables de `.env.example`. Usa una contraseña administrativa aleatoria de al menos 12 caracteres.
4. Genera un dominio público para la aplicación y establece ese valor en `PUBLIC_BASE_URL`.
5. Comparte las bases de Notion con una integración interna y utiliza su token en `NOTION_TOKEN`.
6. En la cuenta de Gmail con verificación en dos pasos, crea una contraseña de aplicación y guárdala en `GMAIL_APP_PASSWORD`.
7. Comprueba `/health`, entra en Configuración y define serie, número inicial, IVA y plazo.

No guardes tokens ni contraseñas en GitHub. Railway debe ser el único lugar donde se configuren esos secretos.

## Variables principales

| Variable | Obligatoria | Uso |
|---|---:|---|
| `DATABASE_URL` | Sí | PostgreSQL de Railway |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Sí | Acceso a la aplicación |
| `NEXLINK_AUTH_TOKEN` | Una opción | Token Nexlink existente |
| `NEXLINK_USERNAME` / `NEXLINK_PASSWORD` | Una opción | Obtención automática del token |
| `NOTION_TOKEN` | Para emitir | Integración interna de Notion |
| `NOTION_INVOICES_DATA_SOURCE_ID` | Para emitir | Fuente de datos de facturas |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Para enviar | Entrega del PDF |

## Comandos

```bash
npm run check
npm test
npm run build
npm start
```

## Primera puesta en marcha

1. Configura las integraciones en Railway.
2. Pulsa **Sincronizar**.
3. Crea las tarifas propias y asígnalas a cada línea.
4. Completa los datos fiscales de cada cliente que estén pendientes.
5. Configura la numeración.
6. Genera una vista previa y revisa destinatario, periodo, líneas e importes.
7. Escribe la confirmación exacta para emitir y enviar.
