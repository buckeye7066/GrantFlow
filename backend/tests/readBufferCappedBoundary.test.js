import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readBufferCapped } from '../services/http/safeFetch.js'

describe('readBufferCapped exact-cap boundary', () => {
  it('keeps a Web response whose body length exactly equals the cap', async () => {
    const response = new Response(Buffer.alloc(100, 7), { status: 200 })

    const result = await readBufferCapped(response, 100)

    expect(result.buffer.length).toBe(100)
    expect(result.truncated).toBe(false)
  })

  it('keeps a Node stream whose body length exactly equals the cap', async () => {
    const stream = Readable.from([
      Buffer.alloc(50, 1),
      Buffer.alloc(50, 2),
    ])

    const result = await readBufferCapped({ body: stream }, 100)

    expect(result.buffer.length).toBe(100)
    expect(result.truncated).toBe(false)
  })
})
