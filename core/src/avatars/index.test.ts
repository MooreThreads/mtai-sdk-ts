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
})
