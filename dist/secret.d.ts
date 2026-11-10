/**
 * Credential-pattern scanning for memory writes.
 *
 * `detectSecrets` returns the human-readable labels of any credential-looking
 * patterns found in a string (never the matched value itself), so the write
 * tools can reject a memory that would leak a secret into a committed file.
 */
/**
 * Return the labels of credential patterns detected in `text`, in detector
 * order and without duplicates. Returns an empty array when the text is clean.
 */
export declare function detectSecrets(text: string): string[];
//# sourceMappingURL=secret.d.ts.map