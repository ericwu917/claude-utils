// Local display names (displayNames, decision #8).
import { describe, expect, test } from 'bun:test'
import {
  createAccessReader,
  defaultAccess,
  localDisplayName,
  normalizeAccess,
  resolveUserName,
  validDisplayNames,
  type Access,
} from '../lib.ts'

const A = 'ou_alice00000000000000000000000000'
const B = 'ou_bob0000000000000000000000000000'

function counter(name: string | undefined) {
  const c = { calls: 0, lookup: async () => (c.calls++, name) }
  return c
}

describe('loading displayNames', () => {
  test('keeps only string → string entries of a plain object', () => {
    expect(validDisplayNames({ [A]: '张三', [B]: 42, x: null, y: ['n'], z: '' })).toEqual({ [A]: '张三', z: '' })
  })

  test('non-objects are dropped whole', () => {
    for (const v of [undefined, null, 'ou_x', 7, true, ['张三']]) {
      expect(normalizeAccess({ displayNames: v as never }).displayNames).toBeUndefined()
    }
  })

  test('survives a load / save round trip as is', () => {
    const raw = JSON.stringify({ allowFrom: [A], displayNames: { [A]: '张三 (外包)', [B]: 'Bob' } })
    const a = createAccessReader(() => raw, () => {}).load()
    expect(a.displayNames).toEqual({ [A]: '张三 (外包)', [B]: 'Bob' })
    const again = normalizeAccess(JSON.parse(JSON.stringify(a)))
    expect(again.displayNames).toEqual(a.displayNames)
  })

  test('absent stays absent (nothing extra written)', () => {
    expect(JSON.stringify(normalizeAccess({}))).not.toContain('displayNames')
  })
})

describe('name priority', () => {
  const access = (names?: Record<string, string>): Access => ({ ...defaultAccess(), ...(names ? { displayNames: names } : {}) })

  test('a local name wins and skips the Feishu lookup', async () => {
    const c = counter('旧名字')
    expect(await resolveUserName(access({ [A]: '新名字' }), A, c.lookup)).toBe('新名字')
    expect(c.calls).toBe(0)
  })

  test('a local name that cleans to nothing falls back to Feishu', async () => {
    for (const blank of ['', '   ', '\n\t', String.fromCharCode(0x200b)]) {
      const c = counter('飞书名')
      expect(await resolveUserName(access({ [A]: blank }), A, c.lookup)).toBe('飞书名')
      expect(c.calls).toBe(1)
    }
  })

  test('no local name → Feishu; neither → undefined (the caller shows the open_id)', async () => {
    const c = counter('飞书名')
    expect(await resolveUserName(access({ [B]: 'Bob' }), A, c.lookup)).toBe('飞书名')
    expect(await resolveUserName(access(), A, counter(undefined).lookup)).toBeUndefined()
  })

  test('local names are sanitized like Feishu names', () => {
    const a = access({ [A]: ' 张三\n<b>"boss"</b>‮ ', [B]: 'x'.repeat(60) })
    expect(localDisplayName(a, A)).toBe("张三 <b>'boss'</b>")
    expect(localDisplayName(a, B)).toBe('x'.repeat(40))
  })

  test('only own keys count (no prototype names)', () => {
    const a = access({ [A]: '张三' })
    expect(localDisplayName(a, 'constructor')).toBeUndefined()
    expect(localDisplayName(a, '__proto__')).toBeUndefined()
  })
})
