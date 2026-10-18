/**
 * Pascal drops the parentheses of a call with no arguments, so `if
 * IsOnPrimaryThread then`, `Flag := EjecutandoSinUI`, the `dmFoo` of
 * `dmFoo.Tabla.Open` and a bare `Paso;` statement are calls that parse as
 * bare identifiers. None of them produced an edge, so routines called only
 * that way (DataModule accessors, mode helpers) showed no callers at all.
 *
 * A bare name is only a call when it names a routine: a parameter, local,
 * field or unit-level variable of that name is that thing, whatever routine
 * elsewhere shares the name, and a method is reachable bare only through the
 * implicit Self.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Edge } from '../src/types';

const LIB = `unit Lib;
interface
type
  TProc = procedure;
  TdmFoo = class
  public
    Tabla: TObject;
  end;
  TOther = class
  public
    function Total: Integer;
  end;
var
  GlobalFlag: Boolean;
function IsOnPrimaryThread: Boolean;
function EjecutandoSinUI: Boolean;
function dmFoo: TdmFoo;
function Tope: Integer;
function Contador: Integer;
function Elemento: Integer;
function Mayor(A, B: Integer): Integer;
function ConDefecto(const S: string = ''): Integer;
procedure Handler;
procedure RegistrarCallback(P: TProc);
implementation
function Mayor(A, B: Integer): Integer;
begin
  Result := A;
end;
function ConDefecto(const S: string = ''): Integer;
begin
  Result := 0;
end;
function TOther.Total: Integer;
begin
  Result := 0;
end;
function IsOnPrimaryThread: Boolean;
begin
  Result := True;
end;
function EjecutandoSinUI: Boolean;
begin
  Result := False;
end;
function dmFoo: TdmFoo;
begin
  Result := nil;
end;
function Tope: Integer;
begin
  Result := 1;
end;
function Contador: Integer;
begin
  Result := 2;
end;
function Elemento: Integer;
begin
  Result := 3;
end;
procedure Handler;
begin
end;
procedure RegistrarCallback(P: TProc);
begin
end;
end.
`;

// A unit Main does not use: its routines are out of Main's scope.
const LEJOS = `unit Lejos;
interface
function Lejano: Boolean;
implementation
function Lejano: Boolean;
begin
  Result := True;
end;
end.
`;

// A unit under a scope prefix, which Main's uses names without it.
const UTILES = `unit Sys.Utiles;
interface
function Ahora: Integer;
implementation
function Ahora: Integer;
begin
  Result := 0;
end;
end.
`;

const MAIN = `unit Main;
interface
uses Lib, Utiles;
type
  TWorker = class
  private
    FCount: Integer;
    Contador: Integer;
    function Total: Integer;
    procedure Paso;
  public
    procedure Run(Elemento: Integer);
  end;
procedure Suelta;
function Comparar(A, B: Integer): Integer;
implementation
function Comparar(A, B: Integer): Integer;
begin
  Result := A - B;
end;
function TWorker.Total: Integer;
begin
  Result := FCount;
end;
procedure TWorker.Paso;
begin
end;
procedure TWorker.Run(Elemento: Integer);
var
  Listo: Boolean;
  Tope: Integer;
begin
  if IsOnPrimaryThread then Exit;
  Listo := EjecutandoSinUI;
  dmFoo.Tabla.Free;
  FCount := Total + Tope + Contador + Elemento;
  Paso;
  RegistrarCallback(Handler);
  if GlobalFlag then Exit;
  FCount := Mayor + ConDefecto + Ahora;
  if Lejano then Exit;
  Ordenar(Comparar);
end;
procedure Suelta;
var
  X: Integer;
begin
  X := Total;
end;
end.
`;

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-implicit-'));
  fs.writeFileSync(path.join(root, 'Lib.pas'), LIB);
  fs.writeFileSync(path.join(root, 'Main.pas'), MAIN);
  fs.writeFileSync(path.join(root, 'Lejos.pas'), LEJOS);
  fs.writeFileSync(path.join(root, 'Sys.Utiles.pas'), UTILES);
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The outgoing edges of the routine named `name` in `file`, as `kind target@file`. */
function edgesFrom(name: string, file: string): string[] {
  const from = cg.getNodesByName(name).filter((n) => n.filePath === file);
  expect(from.length).toBeGreaterThan(0);
  return cg
    .getOutgoingEdgesFrom(from.map((n) => n.id))
    .filter((e: Edge) => e.kind !== 'contains')
    .map((e: Edge) => {
      const target = cg.getNode(e.target)!;
      const callback = e.metadata?.fnRef === true ? ' (callback)' : '';
      return `${e.kind} ${target.name}@${target.filePath}${callback}`;
    })
    .sort();
}

describe('Pascal calls written without parentheses', () => {
  it('link a parameterless function used as a condition or a value', () => {
    const edges = edgesFrom('Run', 'Main.pas');
    expect(edges).toContain('calls IsOnPrimaryThread@Lib.pas');
    expect(edges).toContain('calls EjecutandoSinUI@Lib.pas');
  });

  it('link the accessor at the head of a dotted chain', () => {
    expect(edgesFrom('Run', 'Main.pas')).toContain('calls dmFoo@Lib.pas');
  });

  it('link a bare statement and a method of the own class', () => {
    const edges = edgesFrom('Run', 'Main.pas');
    expect(edges).toContain('calls Paso@Main.pas');
    expect(edges).toContain('calls Total@Main.pas');
    expect(edges).not.toContain('calls Total@Lib.pas');
  });

  it('link a procedure passed as a value as a callback reference', () => {
    expect(edgesFrom('Run', 'Main.pas')).toContain('references Handler@Lib.pas (callback)');
  });

  it('leave a parameter, local, field or variable that shares a routine name alone', () => {
    const edges = edgesFrom('Run', 'Main.pas');
    for (const name of ['Tope', 'Contador', 'Elemento', 'GlobalFlag']) {
      expect(edges.filter((e) => e.includes(` ${name}@`))).toEqual([]);
    }
  });

  it('reach only the units the caller uses, under a scope prefix too', () => {
    const edges = edgesFrom('Run', 'Main.pas');
    expect(edges).toContain('calls Ahora@Sys.Utiles.pas');
    expect(edges.filter((e) => e.includes(' Lejano@'))).toEqual([]);
  });

  it('call only a function that needs no arguments', () => {
    const edges = edgesFrom('Run', 'Main.pas');
    expect(edges).toContain('calls ConDefecto@Lib.pas');
    expect(edges.filter((e) => e.includes(' Mayor@'))).toEqual([]);
  });

  it('credit a same-file function that needs arguments as a callback value', () => {
    expect(edgesFrom('Run', 'Main.pas')).toContain('references Comparar@Main.pas (callback)');
  });

  it('never reach a method by its bare name from a free routine', () => {
    expect(edgesFrom('Suelta', 'Main.pas').filter((e) => e.includes(' Total@'))).toEqual([]);
  });

  it('drop a bare name that names no routine instead of parking it', () => {
    // `GlobalFlag` (a unit-level var of Lib) reaches resolution and fails: a
    // failed implicit call is a property, constant or global, so it is not
    // kept as a failed reference to retry.
    const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(): unknown[] } } } }).db.getDb();
    expect(db.prepare("SELECT reference_name FROM unresolved_refs WHERE reference_kind = 'implicit_call'").all()).toEqual([]);
  });

  it('show the callers of a routine reached only without parentheses', () => {
    for (const name of ['IsOnPrimaryThread', 'EjecutandoSinUI', 'dmFoo']) {
      const target = cg.getNodesByName(name).find((n) => n.filePath === 'Lib.pas' && n.kind === 'function')!;
      const callers = cg.getIncomingEdges(target.id).map((e) => cg.getNode(e.source)!.name);
      expect(callers).toContain('Run');
    }
  });
});

describe('Pascal calls without parentheses into a unit that has copies', () => {
  // The same unit twice: the real one and a fixture copy under a tool's tests,
  // neither nearer the caller than the other. The copy is indexed first.
  const UNIT = `unit ControlUsuarios;
interface
function IsOnPrimaryThread: Boolean;
implementation
function IsOnPrimaryThread: Boolean;
begin
  Result := True;
end;
end.
`;
  const CALLER = `unit Capa;
interface
uses ControlUsuarios;
procedure Registrar;
implementation
procedure Registrar;
begin
  if not IsOnPrimaryThread then Exit;
end;
end.
`;
  let copiesRoot = '';
  let copies: CodeGraph;

  beforeAll(async () => {
    copiesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-copies-'));
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(copiesRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(copiesRoot, rel), text);
    };
    write('Herramientas/Builder/tests/native/ControlUsuarios.pas', UNIT);
    write('VCL/BaseMAX/ControlUsuarios.pas', UNIT);
    write('CyberMAX/tabgen/Capa.pas', CALLER);
    copies = await CodeGraph.init(copiesRoot, { index: true });
  }, 60_000);

  afterAll(() => {
    copies?.close();
    if (copiesRoot) fs.rmSync(copiesRoot, { recursive: true, force: true });
  });

  it('reach the shallowest copy when none is nearer the caller', () => {
    const caller = copies.getNodesByName('Registrar').find((n) => n.kind === 'function')!;
    const targets = copies.getOutgoingEdgesFrom([caller.id])
      .filter((e: Edge) => e.kind === 'calls')
      .map((e: Edge) => copies.getNode(e.target)!.filePath);
    expect(targets).toEqual(['VCL/BaseMAX/ControlUsuarios.pas']);
  });
});
