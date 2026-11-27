import { getAvatars } from './index'
import { setConfig } from '../config'

const DEFAULT_ENDPOINT = 'http://localhost:32101'
const DEFAULT_DH2D_ENDPOINT = 'http://127.0.0.1:32106'

function patchFetch(options: {
  ok?: boolean,
  status?: number,
  statusText?: string,
  body?: unknown,
}) {
  const original = (globalThis as any).fetch
  const calls: unknown[] = []
  ;(globalThis as any).fetch = async (input: unknown) => {
    calls.push(input)
    if (options.ok === false) {
      return {
        ok: false,
        status: options.status ?? 500,
        statusText: options.statusText ?? 'Internal Server Error',
        json: async () => {
          throw new Error('body must not be parsed on HTTP failure')
        },
      }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => options.body }
  }
  return {
    calls,
    restore: () => {
      ;(globalThis as any).fetch = original
    },
  }
}

function restoreDefaultConfig() {
  setConfig({ endpoint: DEFAULT_ENDPOINT })
}

describe('getAvatars', () => {
  afterEach(restoreDefaultConfig)

  test('fetches the DH2D video_configs object and normalizes entries', async () => {
    const fetchMock = patchFetch({
      body: {
        xiaomai: { name: 'Xiao Mai' },
        canna: { name: 'Canna', poster: 'https://cdn.example.com/canna.png' },
        not_an_object: null,
      },
    })
    try {
      const avatars = await getAvatars()
      expect(fetchMock.calls).toEqual([`${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs`])
      expect(avatars).toEqual([
        {
          id: 'xiaomai',
          name: 'Xiao Mai',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/xiaomai/poster`,
        },
        {
          id: 'canna',
          name: 'Canna',
          poster: 'https://cdn.example.com/canna.png',
        },
      ])
    } finally {
      fetchMock.restore()
    }
  })

  test('preserves absolute poster URLs and falls back to the poster route otherwise', async () => {
    const fetchMock = patchFetch({
      body: {
        with_https: { poster: 'https://cdn.example.com/a.png' },
        with_data: { poster: 'data:image/png;base64,AAAA' },
        with_relative: { poster: '/posters/relative.png' },
        without_poster: {},
      },
    })
    try {
      const avatars = await getAvatars()
      const posterById = Object.fromEntries(avatars.map(avatar => [avatar.id, avatar.poster]))
      expect(posterById).toEqual({
        with_https: 'https://cdn.example.com/a.png',
        with_data: 'data:image/png;base64,AAAA',
        with_relative: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/with_relative/poster`,
        without_poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/without_poster/poster`,
      })
    } finally {
      fetchMock.restore()
    }
  })

  test('uses the configured endpoint and omits missing names', async () => {
    setConfig({ endpoint: 'http://dh2d.server:9000', voiceClient: undefined })
    const fetchMock = patchFetch({ body: { solo: {} } })
    try {
      const avatars = await getAvatars()
      expect(fetchMock.calls).toEqual(['http://dh2d.server:9000/api/v1/video_configs'])
      expect(avatars).toEqual([
        { id: 'solo', poster: 'http://dh2d.server:9000/api/v1/video_configs/solo/poster' },
      ])
    } finally {
      fetchMock.restore()
    }
  })

  test('uses the configured voiceClient dh2d_endpoint for discovery and posters', async () => {
    setConfig({
      endpoint: 'http://legacy.server:32101',
      voiceClient: { interaction_endpoint: 'https://127.0.0.1:8782', dh2d_endpoint: 'http://192.168.10.23:32107' },
    })
    const fetchMock = patchFetch({ body: { xiaomai: { name: 'Xiao Mai' } } })
    try {
      const avatars = await getAvatars()
      expect(fetchMock.calls).toEqual(['http://192.168.10.23:32107/api/v1/video_configs'])
      expect(avatars).toEqual([
        {
          id: 'xiaomai',
          name: 'Xiao Mai',
          poster: 'http://192.168.10.23:32107/api/v1/video_configs/xiaomai/poster',
        },
      ])
    } finally {
      fetchMock.restore()
    }
  })

  test('falls back to the legacy endpoint when voiceClient has no dh2d_endpoint', async () => {
    // Runtime partial configs (untyped JavaScript) without voiceClient.dh2d_endpoint
    // keep the legacy avatar discovery target.
    setConfig({
      endpoint: 'http://legacy.server:32101',
      voiceClient: { interaction_endpoint: 'https://127.0.0.1:8782' } as any,
    })
    const fetchMock = patchFetch({ body: { solo: {} } })
    try {
      const avatars = await getAvatars()
      expect(fetchMock.calls).toEqual(['http://legacy.server:32101/api/v1/video_configs'])
      expect(avatars).toEqual([
        { id: 'solo', poster: 'http://legacy.server:32101/api/v1/video_configs/solo/poster' },
      ])
    } finally {
      fetchMock.restore()
    }
  })

  test('throws with status details on HTTP failure', async () => {
    const fetchMock = patchFetch({ ok: false, status: 503, statusText: 'Service Unavailable' })
    try {
      await expect(getAvatars()).rejects.toThrow('Failed to fetch avatars: 503 Service Unavailable')
    } finally {
      fetchMock.restore()
    }
  })

  test('places built-in avatars before non-built-in avatars including numeric IDs', async () => {
    const fetchMock = patchFetch({
      body: {
        '1001': { name: 'Custom One' },
        '2002': { name: 'Custom Two' },
        xiaomai: { name: 'Xiao Mai', built_in: true },
        xiaomai_hair: { name: 'Xiao Mai Hair', built_in: true },
      },
    })
    try {
      const avatars = await getAvatars()
      expect(avatars).toEqual([
        {
          id: 'xiaomai',
          name: 'Xiao Mai',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/xiaomai/poster`,
          built_in: true,
        },
        {
          id: 'xiaomai_hair',
          name: 'Xiao Mai Hair',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/xiaomai_hair/poster`,
          built_in: true,
        },
        {
          id: '1001',
          name: 'Custom One',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/1001/poster`,
        },
        {
          id: '2002',
          name: 'Custom Two',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/2002/poster`,
        },
      ])
      expect('built_in' in avatars[2]).toBe(false)
      expect('built_in' in avatars[3]).toBe(false)
    } finally {
      fetchMock.restore()
    }
  })

  test('recognizes legacy built-in markers and places them ahead of custom avatars', async () => {
    const fetchMock = patchFetch({
      body: {
        '1001': { name: 'Custom', deletable: true, source: 'custom' },
        legacy_builtin: { name: 'Legacy Builtin', builtin: true },
        legacy_is_builtin: { name: 'Legacy Is Builtin', is_builtin: true },
        legacy_not_deletable: { name: 'Legacy Not Deletable', deletable: false },
        legacy_source: { name: 'Legacy Source', source: 'builtin' },
      },
    })
    try {
      const avatars = await getAvatars()
      expect(avatars).toEqual([
        {
          id: 'legacy_builtin',
          name: 'Legacy Builtin',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/legacy_builtin/poster`,
          built_in: true,
        },
        {
          id: 'legacy_is_builtin',
          name: 'Legacy Is Builtin',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/legacy_is_builtin/poster`,
          built_in: true,
        },
        {
          id: 'legacy_not_deletable',
          name: 'Legacy Not Deletable',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/legacy_not_deletable/poster`,
          built_in: true,
        },
        {
          id: 'legacy_source',
          name: 'Legacy Source',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/legacy_source/poster`,
          built_in: true,
        },
        {
          id: '1001',
          name: 'Custom',
          poster: `${DEFAULT_DH2D_ENDPOINT}/api/v1/video_configs/1001/poster`,
        },
      ])
      expect('built_in' in avatars[4]).toBe(false)
    } finally {
      fetchMock.restore()
    }
  })
})
