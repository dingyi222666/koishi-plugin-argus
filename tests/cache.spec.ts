import { strict as assert } from 'node:assert'
import { PeekCache } from '../src/cache'

describe('PeekCache', () => {
    it('separates entries by client, display, and blur', () => {
        assert.notEqual(
            PeekCache.key('alice', undefined, 40),
            PeekCache.key('alice', 0, 40)
        )
        assert.notEqual(
            PeekCache.key('alice', 0, 40),
            PeekCache.key('alice', 0, 0)
        )
        assert.notEqual(
            PeekCache.key('alice', 0, 40),
            PeekCache.key('bob', 0, 40)
        )
        assert.notEqual(
            PeekCache.key('alice', undefined, 40),
            PeekCache.key('alice', 'default', 40)
        )
        assert.notEqual(
            PeekCache.key('alice', 0, 40),
            PeekCache.key('alice', '0', 40)
        )
    })

    it('deletes every entry for a disconnected client', () => {
        const cache = new PeekCache(60_000)
        const aliceDefault = PeekCache.key('alice', undefined, 40)
        const aliceDisplay = PeekCache.key('alice', 'secondary', 0)
        const bob = PeekCache.key('bob', 0, 40)

        cache.set(aliceDefault, {
            image: Buffer.from('alice-default')
        })
        cache.set(aliceDisplay, {
            image: Buffer.from('alice-display')
        })
        cache.set(bob, { image: Buffer.from('bob') })
        cache.deleteClient('alice')

        assert.equal(cache.get(aliceDefault), undefined)
        assert.equal(cache.get(aliceDisplay), undefined)
        assert.ok(cache.get(bob))
        cache.clear()
    })

    it('does not retain entries when caching is disabled', () => {
        const cache = new PeekCache(0)
        const key = PeekCache.key('alice', 0, 40)

        cache.set(key, { image: Buffer.from('alice') })

        assert.equal(cache.get(key), undefined)
    })

    it('stores image and busy responses', () => {
        const cache = new PeekCache(60_000)
        const imageKey = PeekCache.key('alice', 0, 40)
        const busyKey = PeekCache.key('alice', 1, 40)

        cache.set(imageKey, {
            image: Buffer.from('alice')
        })
        cache.set(busyKey, {
            busy: { type: 'peek_busy', id: 'request', app: 'game' }
        })

        assert.deepEqual(cache.get(imageKey)?.image, Buffer.from('alice'))
        assert.equal(cache.get(busyKey)?.busy?.app, 'game')
        cache.clear()
    })
})
