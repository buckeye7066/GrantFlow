import fs from 'node:fs'

const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
const REPLACEMENTS = [
  {
    "path": "backend/services/missionHealthService.js",
    "before": "ICB2ZXJpZmllZF9wY3RfbWluOiA5NSwKICB2ZXJpZmllZF9tYXhfYWdlX2RheXM6IFJFVkVSSUZZX0FGVEVSX0RBWVNfQ09OU1Qs",
    "after": "ICB2ZXJpZmllZF9wY3RfbWluOiA5NSwKICByZWxlYXNlX2NhdGFsb2dfdmVyaWZpZWRfcGN0X21pbjogOTUsCiAgdmlzaWJsZV9kaXJlY3RfdmVyaWZpZWRfcGN0X21pbjogMTAwLAogIHZlcmlmaWVkX21heF9hZ2VfZGF5czogUkVWRVJJRllfQUZURVJfREFZU19DT05TVCw=",
    "label": "mission release catalog targets"
  },
  {
    "path": "backend/services/missionHealthService.js",
    "before": "ICAgICdsaW5rX2xpZmVjeWNsZV9wYXJ0aXRpb25fbWlzbWF0Y2gnLAogICAgJ3ZlcmlmaWVkX3BjdF9iZWxvd190YXJnZXQnLA==",
    "after": "ICAgICdsaW5rX2xpZmVjeWNsZV9wYXJ0aXRpb25fbWlzbWF0Y2gnLAogICAgJ3JlbGVhc2VfY2F0YWxvZ19zbmFwc2hvdF91bmF2YWlsYWJsZScsCiAgICAncmVsZWFzZV9jYXRhbG9nX3ZlcmlmaWVkX3BjdF9iZWxvd190YXJnZXQnLAogICAgJ3Zpc2libGVfZGlyZWN0X2xpbmtfcmVxdWlyZW1lbnRfZmFpbGVkJywKICAgICd2ZXJpZmllZF9wY3RfYmVsb3dfdGFyZ2V0Jyw=",
    "label": "mission release blockers"
  },
  {
    "path": "backend/services/missionHealthService.js",
    "before": "ICAgICAgZGlyZWN0b3J5X29wcG9ydHVuaXRpZXNfdG90YWw6IHRvdGFsRGlyZWN0b3J5LAogICAgICBwbGFjZWhvbGRlcl9vcHBvcnR1bml0aWVzOiBwbGFjZWhvbGRlckNvdW50LA==",
    "after": "ICAgICAgZGlyZWN0b3J5X29wcG9ydHVuaXRpZXNfdG90YWw6IHRvdGFsRGlyZWN0b3J5LAogICAgICByZWxlYXNlX2NhdGFsb2dfdmlzaWJsZV90b3RhbDogcmVsZWFzZUNhdGFsb2dUb3RhbCwKICAgICAgcmVsZWFzZV9jYXRhbG9nX3ZlcmlmaWVkX2ZyZXNoOiByZWxlYXNlQ2F0YWxvZ1ZlcmlmaWVkLAogICAgICByZWxlYXNlX2NhdGFsb2dfdW52ZXJpZmllZF9vcl9zdGFsZTogcmVsZWFzZUNhdGFsb2dVbnZlcmlmaWVkLAogICAgICB2aXNpYmxlX2RpcmVjdF9vcHBvcnR1bml0aWVzX3RvdGFsOiB2aXNpYmxlRGlyZWN0VG90YWwsCiAgICAgIHZpc2libGVfZGlyZWN0X29wcG9ydHVuaXRpZXNfdmVyaWZpZWRfZnJlc2g6IHZpc2libGVEaXJlY3RWZXJpZmllZCwKICAgICAgdmlzaWJsZV9wb2ludGVyX3Jlc291cmNlc190b3RhbDogdmlzaWJsZVBvaW50ZXJUb3RhbCwKICAgICAgdmlzaWJsZV9wb2ludGVyX3Jlc291cmNlc192ZXJpZmllZF9mcmVzaDogdmlzaWJsZVBvaW50ZXJWZXJpZmllZCwKICAgICAgcGxhY2Vob2xkZXJfb3Bwb3J0dW5pdGllczogcGxhY2Vob2xkZXJDb3VudCw=",
    "label": "mission catalog counts"
  },
  {
    "path": "backend/services/missionHealthService.js",
    "before": "ICAgICAgYnJva2VuX3BjdDogYnJva2VuUGN0LAogICAgfSwKICAgIGxpbmtfbGlmZWN5Y2xlOiBsaW5rTGlmZWN5Y2xlLA==",
    "after": "ICAgICAgYnJva2VuX3BjdDogYnJva2VuUGN0LAogICAgICByZWxlYXNlX2NhdGFsb2dfdmVyaWZpZWRfcGN0OiByZWxlYXNlQ2F0YWxvZ1ZlcmlmaWVkUGN0LAogICAgICB2aXNpYmxlX2RpcmVjdF92ZXJpZmllZF9wY3Q6IHZpc2libGVEaXJlY3RUb3RhbCA+IDAgPyB2aXNpYmxlRGlyZWN0VmVyaWZpZWRQY3QgOiBudWxsLAogICAgfSwKICAgIHJlbGVhc2VfY2F0YWxvZzogcmVsZWFzZUNhdGFsb2csCiAgICBsaW5rX2xpZmVjeWNsZTogbGlua0xpZmVjeWNsZSw=",
    "label": "mission catalog rates"
  }
]

function replaceOnce(path, beforeEncoded, afterEncoded, label) {
  const before = decode(beforeEncoded)
  const after = decode(afterEncoded)
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first < 0) throw new Error(path + ': missing expected source for ' + label)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(path + ': expected exactly one source block for ' + label)
  }
  fs.writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length))
}

for (const replacement of REPLACEMENTS) {
  replaceOnce(replacement.path, replacement.before, replacement.after, replacement.label)
}

console.log('Applied mission-small.')
