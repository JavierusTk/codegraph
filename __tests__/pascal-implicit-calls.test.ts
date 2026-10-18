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
procedure Handler;
procedure RegistrarCallback(P: TProc);
implementation
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

const MAIN = `unit Main;
interface
uses Lib;
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
implementation
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
