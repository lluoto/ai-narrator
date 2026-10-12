# V6 8000 Structured-Source Smoke Report

- Status: **completed**
- Gate: **proposal smoke only unless independently verified**
- Scope: isolated ten-record measurement only. No queue, prompt, candidate, full-batch, or runtime state was changed.
- Verifier: no independent verifier was called; no 8001 request was made.

| route | records | HTTP statuses | transport failures | JSON parsed | schema valid | source lints | categorical surface | categorical enum |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| `bounded_event` | 5 | `{"200": 5}` | 0 | 5 | 5 | 0 | 3 | 0 |
| `entity_profile` | 5 | `{"200": 5}` | 0 | 5 | 5 | 0 | 0 | 0 |

- Request contract: 8000 exact selected model, thinking off, `temperature=0`, `max_tokens=1500`, serial one call per item, no retries, raw capture, JSON/schema validation.
- V5 comparison: `v5_to_v6_comparison.json` covers only the two overlapping bounded-event targets.
