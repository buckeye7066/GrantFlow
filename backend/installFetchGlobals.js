// Replace Node's bundled fetch family with userland undici before any module
// captures it. Node 24.19.0 bundles undici 7.29.0, whose HTTP/1 parser throws an
// uncatchable AssertionError (`assert(!this.paused)`) from the socket 'end'
// handler when a server closes a connection whose response body was not read
// (nodejs/undici#5360, fixed on the 8.x line in 8.4.1). In production it
// crash-restarted the server during an Amy crawl on 2026-09-11. Node 24.21.0
// bundles 7.29.1, which does not carry the fix either.
//
// install() swaps fetch, Headers, Request, Response and FormData together, so a
// FormData body is always paired with the fetch that serializes it.
import { install } from 'undici'

install()
