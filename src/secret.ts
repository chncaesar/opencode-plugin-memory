/**
 * Credential-pattern scanning for memory writes.
 *
 * `detectSecrets` returns the human-readable labels of any credential-looking
 * patterns found in a string (never the matched value itself), so the write
 * tools can reject a memory that would leak a secret into a committed file.
 */

type Detector = { label: string; pattern: RegExp }

const DETECTORS: Detector[] = [
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    label: "GitHub token",
    pattern: /github_pat_[A-Za-z0-9_]{82}|\bghp_[A-Za-z0-9]{36}\b|\bgh[ors]_[A-Za-z0-9]{20,}\b/,
  },
  // `sk-` test/placeholder keys are excluded; `sk-proj-` project keys are included.
  { label: "OpenAI key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}|sk-(?!test)[A-Za-z0-9]{20,}/ },
  { label: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "API key", pattern: /(?:api[_-]?key|apikey|api_token)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i },
  { label: "private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { label: "database connection string", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:/\s]+:[^@\s]+@/i },
  { label: "Stripe key", pattern: /(?:sk|pk)_live_[0-9a-zA-Z]{16,}/ },
  { label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
]

/**
 * Return the labels of credential patterns detected in `text`, in detector
 * order and without duplicates. Returns an empty array when the text is clean.
 */
export function detectSecrets(text: string): string[] {
  const found: string[] = []
  for (const { label, pattern } of DETECTORS) {
    if (pattern.test(text)) found.push(label)
  }
  return found
}
