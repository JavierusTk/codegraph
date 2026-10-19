---
effort: large
id: T-MBEP
origin: sesión 2026-10-19, medidas del sync del motor upstream 1.6.2 sobre W:\
priority: media
proposal: 'Rehacer solo los pases afectados por los lenguajes de los ficheros cambiados,
  conservando las aristas de los demás; alternativa más barata: dar el pool de workers
  a refreshSynthesis'
risk: med
scope: src/index.ts (sync) y src/resolution/callback-synthesizer.ts (synthesizeCallbackEdges,
  SYNTH_PASSES)
type: idea
value: high
verification: Con 1 fichero .pas cambiado, el sync tarda menos de 30 s y deja las
  mismas aristas sintetizadas que una resíntesis completa (test de equivalencia sync
  incremental = índice completo)
---
# El sync rehace la síntesis completa de aristas dinámicas por cualquier cambio en Pascal

## Contexto

El usuario aceptó cortar a upstream 1.6.2 sabiendo este coste y pidió mejorarlo después. Este item es esa mejora.

## Evidencia

- **Qué dispara la resíntesis**: `src/index.ts:925-943` activa `refreshSynthesis` si algún fichero cambiado cumple `hasSynthesisPattern` (`src/resolution/callback-synthesizer.ts:4487`). Lo cumple cualquier `.dfm` y cualquier contenido con `class`, `interface`, etc. En la práctica, **toda unit Pascal**.
- **Qué hace**: `refreshSynthesis` (`src/resolution/index.ts`, unas 2.640 líneas en adelante) llama a `synthesizeCallbackEdges(..., pool = null)`. Los ~30 pases recorren **todo el grafo** en el hilo principal, sobre `SynthesisStage` (tablas TEMP), y `publish` reescribe todas las aristas sintetizadas.
- **Medidas en `W:\`** (2,6 M nodos), logs `sync-timing*.log` y `sync-lag.log` en `C:/Users/Javier/dev/codegraph-migration/`:

  | Caso | Duración |
  |---|---|
  | 1 fichero cambiado | 2 min 51 s y 4 min 27 s |
  | Con la máquina cargada | más de 10 min |
  | Solo la resíntesis, sin cambios | unos 100 s |
  | Motor viejo 1.0.1, catch-up de 99 a 211 ficheros (referencia) | 1,5 a 4 min |

- **Pases más caros:**

  | Pase | Tiempo |
  |---|---|
  | `rnEventEdgesList` | 17-131 s |
  | `flutterEdges` | 12-39 s |
  | `cppEdges` | 12 s |
  | `ifaceEdges` | 9-11 s |
  | `fieldEdges` | 6-43 s |
  | `emitterEdges` | 4 s (332 s con poca memoria) |
  | `pascalEdges` | solo 2-4 s |

- Upstream ya condiciona cada pase a que el lenguaje exista en el índice (`has(...)` en `SYNTH_PASSES`, `callback-synthesizer.ts:4523` en adelante), pero `W:\` tiene de casi todo: TS, JS, Python, C++, Dart...

## Propuesta

- **A (la buena):** en un `sync`, ejecutar solo los pases cuyos lenguajes de entrada aparecen entre los ficheros cambiados (y sus dependencias: JSX/barrels, `lazyValueModules`). Borrar y reinsertar solo las aristas cuyo `metadata.synthesizedBy` pertenece a esos pases. Hace falta mapear qué lee cada pase y un test de equivalencia: sync incremental = índice completo, el criterio de convergencia de upstream (CG-33).
- **B (más barata):** pasar a `refreshSynthesis` el pool de workers, como ya hace el indexado completo (`resolveReferencesBatched`, unas 2.608 líneas en `src/resolution/index.ts`). No reduce el trabajo, pero lo saca del hilo principal y lo reparte.
- Las dos son candidatas a un PR en upstream.

## Relacionado

`codegraph:T-RSRM`: el guardián mata el daemon durante el catch-up. Un catch-up más corto reduce la ventana de riesgo.
