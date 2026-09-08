/**
 * Engine API for the UI. In the browser the heavy calls run in a Web Worker;
 * in tests (and as a fallback) they run inline. Requests are plain data so
 * they survive structured cloning.
 */
import { reapply, type ReapplyInput, type ReapplyResult } from './reapply'
import { guard, type GuardInput, type GuardResult } from './guard'
import { normalizePaste, type NormalizedPaste } from './normalize'
import type { EngineRequest, EngineResponse } from './rpc'

export interface ReapplyRequest extends Omit<ReapplyInput, 'real' | 'orgHostRegex'> {
  real?: Array<[string, string]>
  orgHostRegex?: string
}

export interface GuardRequest extends Omit<GuardInput, 'real' | 'orgHostRegex'> {
  real: Array<[string, string]>
  orgHostRegex?: string
}

export interface EngineApi {
  reapply(req: ReapplyRequest): Promise<ReapplyResult>
  guard(req: GuardRequest): Promise<GuardResult>
  normalizePaste(raw: string): Promise<NormalizedPaste>
}

function regexOf(source: string | undefined): RegExp | undefined {
  if (!source) return undefined
  try {
    return new RegExp(source, 'i')
  } catch {
    return undefined
  }
}

export function toReapplyInput(req: ReapplyRequest): ReapplyInput {
  const { real, orgHostRegex, ...rest } = req
  const re = regexOf(orgHostRegex)
  return { ...rest, ...(real ? { real: new Map(real) } : {}), ...(re ? { orgHostRegex: re } : {}) }
}

export function toGuardInput(req: GuardRequest): GuardInput {
  const { real, orgHostRegex, ...rest } = req
  const re = regexOf(orgHostRegex)
  return { ...rest, real: new Map(real), ...(re ? { orgHostRegex: re } : {}) }
}

export const directEngine: EngineApi = {
  reapply: async (req) => reapply(toReapplyInput(req)),
  guard: async (req) => guard(toGuardInput(req)),
  normalizePaste: async (raw) => normalizePaste(raw),
}

export function createEngineClient(): EngineApi {
  if (typeof Worker === 'undefined') return directEngine
  let worker: Worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return directEngine
  }
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  worker.onmessage = (ev: MessageEvent<EngineResponse>) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    pending.delete(ev.data.id)
    if (ev.data.ok) p.resolve(ev.data.result)
    else p.reject(new Error(ev.data.error))
  }
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'Engine worker failed'))
    pending.clear()
  }
  const call = <T>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const req: EngineRequest = { id, method, params }
      worker.postMessage(req)
    })
  return {
    reapply: (req) => call('reapply', req),
    guard: (req) => call('guard', req),
    normalizePaste: (raw) => call('normalizePaste', raw),
  }
}
