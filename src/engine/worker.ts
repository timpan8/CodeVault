/// <reference lib="webworker" />
import { handleRequest, registerMethod, type EngineRequest, type EngineResponse } from './rpc'
import { reapply } from './reapply'
import { guard } from './guard'
import { normalizePaste } from './normalize'
import { toGuardInput, toReapplyInput, type GuardRequest, type ReapplyRequest } from './client'

registerMethod('reapply', (p) => reapply(toReapplyInput(p as ReapplyRequest)))
registerMethod('guard', (p) => guard(toGuardInput(p as GuardRequest)))
registerMethod('normalizePaste', (p) => normalizePaste(p as string))

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const { id, method, params } = event.data
  let response: EngineResponse
  try {
    const result = await handleRequest(method, params)
    response = { id, ok: true, result }
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  scope.postMessage(response)
}
