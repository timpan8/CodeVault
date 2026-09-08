/**
 * Engine RPC registry. The engine runs inside a Web Worker; the UI talks to it
 * through `EngineRequest`/`EngineResponse` messages. Every method here must be
 * a pure function of its parameters: no DOM, no storage, no globals.
 *
 * Methods are added milestone by milestone (lex, reapply, guard, ...).
 */
export interface EngineRequest {
  id: number
  method: string
  params: unknown
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

type Handler = (params: unknown) => unknown | Promise<unknown>

const handlers: Record<string, Handler> = {
  ping: () => 'pong',
}

export function registerMethod(name: string, handler: Handler): void {
  handlers[name] = handler
}

export function listMethods(): string[] {
  return Object.keys(handlers).sort()
}

export async function handleRequest(method: string, params: unknown): Promise<unknown> {
  const handler = handlers[method]
  if (!handler) {
    throw new Error(`Unknown engine method: ${method}`)
  }
  return handler(params)
}
