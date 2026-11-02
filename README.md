# Adviento Chiquito

La web sigue alojada en GitHub Pages. Vercel aloja únicamente el servicio
`/api/progress`, que guarda respuestas y progreso en un repositorio **privado**.
El navegador conserva también su guardado local.

## Recorrido y cartas

El recorrido de `days.json` sitúa a Samu en Corea el día 1 y de regreso a
Barcelona el 2; en la casa rural con el clan de El Ejido del 5 al 8; en
Barcelona del 9 al 19; y con la familia desde el 20 hasta después del final.
El sobre 8 puede viajar a la casa rural o recogerse al volver. El sobre 20
se entrega antes de salir de Barcelona y viaja cerrado hasta resolver el 24.
Ninguna recogida pendiente bloquea el calendario.

Las cartas se registran al completar los pisos 5 (Marujito), 9 (Chiquito),
12 (Lolo) y 23 (Tombi). La colección se calcula a partir de las misiones
completadas y disponibles por fecha: no añade puntos, premios repetidos ni
nuevos datos al guardado. El modo autor permite previsualizarlas sin afectar
al progreso real. Los textos de cada `character` se pueden editar en el editor
visual local, junto a la historia y la prueba; los identificadores y las
ilustraciones quedan protegidos.
La colección permanece visible en el perfil, debajo del botín de incursión.
Se recorre lateralmente, deslizando, con flechas o con las teclas
de dirección, Inicio y Fin al enfocar el carrusel. No avanza automáticamente.
El expediente de la carta seleccionada se despliega debajo; las cartas
pendientes no muestran su identidad ni su expediente.

## Activar la copia privada

1. Importa en Vercel el repositorio de **código** `gemmacodes/adventdcc`.
   Usa la raíz del repositorio y el preset **Other**. `vercel.json` configura
   el servicio sin un comando de build ni dependencias adicionales.
   No importes el repositorio de datos como proyecto de Vercel.
2. Crea un token de GitHub de acceso específico —fine-grained— con acceso
   **solo** a `gemmacodes/adventdcc-data` y permiso **Contents: Read and write**.
   Su caducidad debe cubrir la duración del regalo. No reutilices la credencial
   de Copilot ni concedas acceso a todos tus repositorios.
3. Genera una clave independiente para el enlace personal de Samu:
   `openssl rand -hex 32`. No es el token de GitHub.
4. Añade estas variables protegidas en Vercel, solo para **Production**:

   | Variable | Valor |
   |---|---|
   | `ALLOWED_ORIGIN` | `https://advientochiquito.dpdns.org` |
   | `GITHUB_DATA_REPOSITORY` | `gemmacodes/adventdcc-data` |
   | `GITHUB_TOKEN` | El token de GitHub del paso 2 |
   | `PROGRESS_ACCESS_KEY` | La clave aleatoria del paso 3 |

   No pegues las claves en el chat, `config.js`, un commit o el repositorio público.
   Las variables nuevas requieren un despliegue de Vercel.
5. El endpoint de producción debe poder recibir peticiones sin un inicio de sesión
   de Vercel: la propia función exige la clave personal y el origen permitido.
   No actives analítica o registros que capturen cabeceras de autorización o respuestas.
6. Copia la URL estable de producción de Vercel en `CONFIG.sync.endpoint`,
   con la ruta `/api/progress`, y publica ese cambio en GitHub Pages.
   La configuración pública contiene la URL, **nunca ninguna clave**.
7. El enlace que recibe Samu tiene este formato:
   `https://advientochiquito.dpdns.org/#backupKey=CLAVE_PERSONAL`.
   El navegador guarda la clave y la retira de la barra de direcciones.
   Cualquier persona que tenga este enlace podrá leer y actualizar la copia:
   compártelo únicamente con Samu. En un navegador nuevo necesita abrirlo otra vez.

El JSON `progress/incursion-2026-v2.json` se crea en el repositorio privado al
activar la copia con el enlace personal, aunque todavía no haya respuestas.
Vercel no escribe las respuestas en su disco
temporal ni en el repositorio público. Los commits de datos no despliegan la web.

## Comportamiento

- Los borradores se guardan inmediatamente en el navegador; los envíos se agrupan
  tras una pausa de escritura. Completar una misión adelanta el envío.
- Si falla la red, el progreso local se conserva y se reintenta con espera creciente.
  El estado visible distingue guardado local de copia privada confirmada.
- El modo autor nunca lee ni escribe progreso remoto. El perfil no muestra
  controles de descarga ni restauración manual de copias en ninguno de los modos.
- En un navegador nuevo se recuperan los pisos que no tengan registros locales.
  Los existentes no se reemplazan automáticamente.
- Las revisiones por piso y la escritura condicional de GitHub impiden que una
  copia antigua sobrescriba otra más reciente. Un conflicto conserva el registro
  local y el remoto e informa del problema; no elige una respuesta silenciosamente.
- El servicio comprueba que el repositorio de datos sea privado antes de acceder
  a los registros. Un JSON corrupto no se reemplaza por una copia vacía.

## Comprobaciones locales

Sin instalar dependencias ni ejecutar builds:

```sh
node --test tests/progress.test.mjs tests/character-cards.test.mjs
```

La regresión de navegador se abre en `tests/campaign.html` desde el servidor local.
Usa almacenamiento, credenciales y peticiones simuladas; no envía datos a GitHub.
