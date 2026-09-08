import { describe, expect, it } from 'vitest'
import { handleRequest, listMethods, registerMethod } from '@engine/rpc'

describe('engine rpc', () => {
  it('answers ping', async () => {
    expect(await handleRequest('ping', undefined)).toBe('pong')
  })

  it('rejects unknown methods', async () => {
    await expect(handleRequest('nope', undefined)).rejects.toThrow(/Unknown engine method/)
  })

  it('registers methods', async () => {
    registerMethod('double', (p) => (p as number) * 2)
    expect(await handleRequest('double', 21)).toBe(42)
    expect(listMethods()).toContain('double')
  })
})
