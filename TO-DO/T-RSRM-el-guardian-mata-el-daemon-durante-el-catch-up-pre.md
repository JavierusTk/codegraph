---
effort: medium
id: T-RSRM
origin: sesión 2026-10-19, corte en vivo de codegraph a upstream 1.6.2
priority: alta
proposal: Primero CODEGRAPH_QUERY_POOL_SIZE=4 en los wrappers de W:/bin y observar
  daemon.log unos días; si persiste, CODEGRAPH_WATCHDOG_TIMEOUT_MS=600000; si se confirma
  la causa en el motor, issue/PR upstream
risk: med
scope: daemon MCP de W:\ (motor upstream 1.6.2, rama cyber/upstream-1.6) y wrappers
  de W:/bin
type: bug
value: high
verification: W:\.codegraph\daemon.log sin "Main thread unresponsive" ni daemons sustituidos
  sin "Shutting down" durante varios días con catch-ups reales; codegraph_explore
  no responde "busy" tras arrancar el daemon; la memoria del daemon se queda por debajo
  de unos 4 GB
---
# El guardián mata el daemon durante el catch-up (¿presión de memoria y disco del pool de 16 workers?)

## Contexto

Desde el corte del 2026-10-19, el codegraph vivo de `W:\` es upstream 1.6.2 más los parches propios: rama `cyber/upstream-1.6` en `W:\Public\codegraph` e índice en `W:\.codegraph` (5,9 GB, 2,66 M nodos). Todas las sesiones de Claude y Codex comparten un único daemon (`serve --mcp`). Como el watcher está apagado (`CODEGRAPH_NO_WATCH=1`, motivo en `W:/bin/codegraph`), el daemon hace un catch-up (`sync`) cada vez que arranca.

## Evidencia

- `W:\.codegraph\daemon.log` (horas UTC): a las `19:24:55Z` y a las `20:57:48Z` aparece «Main thread unresponsive for ~60s — killing the wedged process». Las dos veces ocurrió unos 75-80 s después de arrancar, en pleno catch-up con unos 50 ficheros cambiados y con consultas MCP concurrentes (las pruebas de la sesión).
- **Muertes silenciosas**: los daemons con PID 73136 (`21:14:08Z`) y 32920 (`21:16:03Z`) fueron sustituidos sin «Shutting down» ni «unresponsive». El registro de Windows no recoge ningún cierre de `node.exe`; solo un `LiveKernelEvent` a las 22:56 hora local. Siguen sin explicar. No es el relevo por versión: `stopOlderDaemon` (`src/mcp/daemon-registry.ts:391`) solo sustituye daemons de una versión anterior.
- **Bucle**: `synthesis_pending` pasa a `1` antes de resintetizar y solo vuelve a `0` al terminar (`src/index.ts:1280-1283`). Un daemon que muere a mitad deja la resíntesis pendiente y el siguiente la repite.
- El guardián (`src/mcp/liveness-watchdog.ts`, 60 s, ajustable con `CODEGRAPH_WATCHDOG_TIMEOUT_MS`) solo aplaza la muerte si cambian el tamaño o la fecha de `codegraph.db` o `-wal`. Ni las lecturas ni las escrituras en tablas TEMP (la resíntesis va por `SynthesisStage`, `src/db/synthesis-stage.ts`) cuentan como avance.

## Reproducción

Hecha en modo directo (`CODEGRAPH_NO_DAEMON=1`), sin guardián (`CODEGRAPH_NO_WATCHDOG=1`) y con un preload que detecta los bloqueos del event loop, sobre una copia del índice en `W:\.codegraph-probe`, ya borrada. Logs en `C:/Users/Javier/dev/codegraph-migration/`:

- `catchup-repro.log`: catch-up de unos 50 ficheros con un pool de 2 workers. El hilo principal se bloqueó como mucho 11,1 s y el catch-up tardó 157 s. **No se reproduce el bloqueo de 60 s.**
- `sync-lag.log`: `sync` por CLI con solo la resíntesis. Ningún bloqueo de más de 5 s salvo el arranque.
- `catchup-repro2.log`: `CODEGRAPH_QUERY_POOL_SIZE=16`, 3 `codegraph_explore` concurrentes cada 20 s y resíntesis forzada. El servidor llegó a **12,8 GB en unos 3,5 minutos y saturó el disco** (lo notó el usuario), y todos los `explore` respondieron «busy» tras 45 s en cola. Prueba en parte contaminada: se cortó por el disco.

Los scripts están en `C:/Users/Javier/dev/codegraph-migration/repro/`:
- `mcp-catchup.js`: lanza `serve --mcp` por el wrapper, hace un ping cada 20 s y admite `HEAVY=n`.
- `lagmon.js`: preload para `NODE_OPTIONS=--require=...`; pone hora a `console.error` y avisa de bloqueos de más de 5 s.
- `mcp-probe.js`: batería MCP corta.

**Ojo:** si se mata el cliente, el servidor no se cierra, porque el `cmd.exe` intermedio mantiene abierta la entrada estándar. Hay que matar el árbol entero (`taskkill /T`); si no, el servidor sigue vivo y acumula memoria.

## Hipótesis (no demostrada)

Cada conexión SQLite reserva `cache_size = -64000` (64 MB) y `mmap_size = 268435456` (256 MB) (`src/db/index.ts:35-37`). El daemon abre hasta 16 workers de consulta (`clamp(cores-1, 1, 16)`, `resolvePoolSize` en `src/mcp/query-pool.ts`), cada uno con su conexión a la BD de 5,9 GB. Con consultas pesadas y el catch-up a la vez, la presión de memoria y de E/S deja el hilo principal parado en fallos de página. Como leer no cambia ni la BD ni el WAL, el guardián no ve avance y mata el proceso.

## Propuesta, en orden para aislar la causa

1. Añadir `CODEGRAPH_QUERY_POOL_SIZE=4` a `W:/bin/codegraph`, con su entrada en `WSLENV`, y a `W:/bin/codegraph.cmd`. Observar `daemon.log` unos días: `grep -E "Listening on|Shutting down|unresponsive" W:/.codegraph/daemon.log`.
2. Si siguen las muertes: `CODEGRAPH_WATCHDOG_TIMEOUT_MS=600000`. Un bloqueo real se seguiría matando a los 10 minutos.
3. Si se confirma que la causa está en el motor, abrir un issue o PR en upstream: pool proporcional a la memoria disponible, `mmap` por worker, o contar la E/S de lectura como avance.

## Relacionado

El coste de la resíntesis completa en cada `sync` agrava el problema, porque alarga el catch-up; tiene su propio item en este registro. El estado de la migración está en la memoria del proyecto (`codegraph-upstream-1-6-migration`).
