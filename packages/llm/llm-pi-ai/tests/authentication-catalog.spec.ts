import { beforeEach, describe, expect, it, vi } from 'vitest'

const catalogProvider = vi.hoisted(() => vi.fn())
const createModels = vi.hoisted(() => vi.fn(() => ({ setProvider: vi.fn() })))

vi.mock('../src/catalog.ts', () => ({ catalogProvider }))
vi.mock('@earendil-works/pi-ai', () => ({ createModels }))

import { openAiCodexAuthentication } from '../src/authentication.ts'

beforeEach(() => {
  catalogProvider.mockReset()
  createModels.mockClear()
})

describe('OpenAI Codex catalog invariant', () => {
  it('rejects a missing installed provider', () => {
    catalogProvider.mockReturnValue(undefined)
    expect(() => openAiCodexAuthentication({} as never)).toThrow('no OpenAI Codex OAuth provider')
  })

  it('rejects an installed provider without OAuth', () => {
    catalogProvider.mockReturnValue({ auth: {} })
    expect(() => openAiCodexAuthentication({} as never)).toThrow('no OpenAI Codex OAuth provider')
  })
})
