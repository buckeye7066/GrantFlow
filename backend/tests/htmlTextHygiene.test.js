/**
 * htmlTextHygiene — the named-entity registry is a CLOSED CHARACTER BLOCK, not
 * a hand-typed list of the ones someone happened to hit.
 *
 * OWNER REPORT 2026-08-21: a stored funding-opportunity title read
 *   "Improving global health security in C&ocirc;te d'Ivoire through
 *    collaboration with local partners"
 * — raw markup, in an owner-facing title. The row DID pass through the ingest
 * choke point (`opportunityInserter` calls `cleanExtractedText`). The defect
 * was that `ocirc` was simply absent from `NAMED_ENTITIES`, which carried
 * `eacute/egrave/agrave/ccedil/ntilde/uuml/ouml/auml` and NONE of the
 * circumflex, ring, slash, ligature, acute-vowel or thorn forms. Per the
 * module's own (correct) policy an unknown entity is left VERBATIM, so a
 * registry gap renders as markup rather than as mangled text.
 *
 * The fix generates the Latin-1 letter half from one table so the next gap
 * cannot open one letter at a time — and these tests assert the BLOCK, not the
 * single character the owner happened to see.
 */

import { describe, it, expect } from 'vitest'
import { decodeHtmlEntities, cleanExtractedText } from '../utils/htmlTextHygiene.js'

describe('htmlTextHygiene — the owner\'s reported title', () => {
  it('decodes &ocirc; in a real stored title', () => {
    const raw = "Improving global health security in C&ocirc;te d&apos;Ivoire through collaboration with local partners"
    expect(cleanExtractedText(raw)).toBe("Improving global health security in Côte d'Ivoire through collaboration with local partners")
  })
})

describe('the Latin-1 letter block, not a hand-picked subset', () => {
  const cases = [
    // The accent families that were entirely missing before 2026-08-21.
    ['&ocirc;', 'ô'], ['&acirc;', 'â'], ['&ecirc;', 'ê'], ['&icirc;', 'î'], ['&ucirc;', 'û'],
    ['&aring;', 'å'], ['&oslash;', 'ø'], ['&aelig;', 'æ'], ['&oelig;', 'œ'], ['&szlig;', 'ß'],
    ['&aacute;', 'á'], ['&iacute;', 'í'], ['&oacute;', 'ó'], ['&uacute;', 'ú'], ['&yacute;', 'ý'],
    ['&igrave;', 'ì'], ['&ograve;', 'ò'], ['&ugrave;', 'ù'],
    ['&iuml;', 'ï'], ['&yuml;', 'ÿ'], ['&otilde;', 'õ'], ['&atilde;', 'ã'],
    ['&thorn;', 'þ'], ['&eth;', 'ð'],
    // The ones that already worked must keep working.
    ['&eacute;', 'é'], ['&ccedil;', 'ç'], ['&ntilde;', 'ñ'], ['&uuml;', 'ü'],
  ]
  it.each(cases)('decodes %s', (entity, expected) => {
    expect(decodeHtmlEntities(entity)).toBe(expected)
  })

  it('preserves CASE — &Ocirc; is Ô, not ô', () => {
    // The lookup was `NAMED_ENTITIES[body.toLowerCase()]`, which silently
    // lower-cased every accented capital. Case carries meaning for letters.
    expect(decodeHtmlEntities('&Ocirc;')).toBe('Ô')
    expect(decodeHtmlEntities('&Eacute;')).toBe('É')
    expect(decodeHtmlEntities('&Ccedil;')).toBe('Ç')
    expect(decodeHtmlEntities('&AElig;')).toBe('Æ')
  })

  it('keeps the case-INSENSITIVE fallback the punctuation entities rely on', () => {
    expect(decodeHtmlEntities('&AMP;')).toBe('&')
    expect(decodeHtmlEntities('&NBSP;x')).toBe(' x')
  })
})

describe('the conservative policy is unchanged', () => {
  it('leaves an UNKNOWN entity verbatim — mangling text is worse than showing an entity', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;')
  })

  it('still decodes numeric entities by code point', () => {
    expect(decodeHtmlEntities('&#244;')).toBe('ô')
    expect(decodeHtmlEntities('&#xF4;')).toBe('ô')
  })

  it('passes non-strings through untouched — silence is not a value', () => {
    expect(cleanExtractedText(null)).toBe(null)
    expect(cleanExtractedText(undefined)).toBe(undefined)
    expect(cleanExtractedText(42)).toBe(42)
  })

  it('a string with no ampersand is returned as-is', () => {
    expect(decodeHtmlEntities('Federal Pell Grant')).toBe('Federal Pell Grant')
  })
})
